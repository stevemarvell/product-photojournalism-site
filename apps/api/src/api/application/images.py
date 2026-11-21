"""Image use cases (spec sections 9 and 11). Every call is for one organisation."""

import uuid
from datetime import timedelta

from api.application.ports import (
    Clock,
    ImageProcessor,
    ImageRenderer,
    ImageRepository,
    ImageStore,
    OriginalUploads,
    UploadTarget,
)
from api.domain import (
    ImageAlreadyRegisteredError,
    ImageNotFoundError,
    ImageProcessingError,
    ImageRecord,
    ImageRefusedError,
    ImageStatus,
    ImageTooLargeError,
    WebVersion,
    failed,
    new_image,
    ready,
    timed_out,
)


def process_image(
    organisation_id: str,
    image_id: str,
    *,
    images: ImageRepository,
    uploads: OriginalUploads,
    store: ImageStore,
    renderer: ImageRenderer,
) -> None:
    """Turn the original into web versions and record the outcome (ready or failed).

    Never raises: a worker has nobody to tell, so a failure is the row's `failed`. The row
    is only changed while it is still processing, so an image already failed by the timeout
    stays failed.
    """
    image = images.get(organisation_id, image_id)
    if image is None or image.status is not ImageStatus.PROCESSING:
        return
    try:
        original = uploads.read(image.original_url)
        if original is None:
            raise ImageProcessingError("original is missing")
        rendered = renderer.render(original)
        versions = tuple(
            WebVersion(width, store.put(f"{image.id}-{width}.jpg", data))
            for width, data in rendered.versions
        )
        outcome = ready(image, rendered.width, rendered.height, versions)
    except Exception:  # noqa: BLE001 - whatever went wrong, the image is failed, not lost
        outcome = failed(image)
    images.replace_if_status(organisation_id, outcome, ImageStatus.PROCESSING)


class ImageService:
    """Register, read and time out images. Also the real `ImageStatusLookup`."""

    def __init__(
        self,
        images: ImageRepository,
        uploads: OriginalUploads,
        processor: ImageProcessor,
        clock: Clock,
        *,
        max_bytes: int,
        timeout: timedelta,
    ) -> None:
        self._images = images
        self._uploads = uploads
        self._processor = processor
        self._clock = clock
        self._max_bytes = max_bytes
        self._timeout = timeout

    @property
    def max_bytes(self) -> int:
        return self._max_bytes

    def upload_target(self, organisation_id: str, size: int) -> UploadTarget:
        """Where to upload one original. Refuses a file over the limit before anything is
        issued; the upload itself is limited again where the bytes arrive."""
        if size > self._max_bytes:
            raise ImageTooLargeError(self._max_bytes)
        target = self._uploads.issue(organisation_id)
        self._images.bind_upload(organisation_id, target.original_url)
        return target

    def register(self, organisation_id: str, original_url: str) -> ImageRecord:
        """Create the row (status processing) for an uploaded original and start processing.

        Raises ImageRefusedError for a URL that is not an upload issued to this organisation,
        ImageAlreadyRegisteredError for one already registered, and ImageTooLargeError
        when the stored file is over the limit: the size is read from storage, not trusted
        from the browser.
        """
        if not self._images.upload_issued_to(organisation_id, original_url):
            raise ImageRefusedError("no such upload")
        size = self._uploads.size(original_url)
        if size is None:
            raise ImageRefusedError("no such upload")
        if size > self._max_bytes:
            raise ImageTooLargeError(self._max_bytes)
        image = new_image(str(uuid.uuid4()), organisation_id, original_url, size, self._clock.now())
        # The claim and the row are one step, so a failed create never burns the upload.
        if not self._images.create_claiming(image):
            raise ImageAlreadyRegisteredError(original_url)
        self._processor.enqueue(organisation_id, image.id)
        return image

    def get(self, organisation_id: str, image_id: str) -> ImageRecord:
        """The image; one still processing past the timeout is marked failed first."""
        image = self._images.get(organisation_id, image_id)
        if image is None:
            raise ImageNotFoundError(image_id)
        if timed_out(image, self._clock.now(), self._timeout):
            gave_up = failed(image)
            if self._images.replace_if_status(organisation_id, gave_up, ImageStatus.PROCESSING):
                return gave_up
            # The worker finished first; read what it wrote.
            return self.get(organisation_id, image_id)
        return image

    def status(self, organisation_id: str, image_id: str) -> ImageStatus | None:
        """The ImageStatusLookup the publish rule uses; None when there is no such image."""
        try:
            return self.get(organisation_id, image_id).status
        except ImageNotFoundError:
            return None
