"""What a story body may contain (spec section 4). Pure: no I/O, no framework.

The body is MDX text, but the only markup allowed is paragraphs, `**bold**`,
`*italic*` and self-closing `<Photo image=".." alt=".." caption=".." credit=".." />`
tags: only those four attributes (image and alt required), each once,
double-quoted, with `"`, `<`, `>` and `&` written as entities.
Anything else that MDX would treat as code or markup (another tag, raw HTML,
`{expressions}`, `import`/`export`) is refused here, so a renderer that reads the
stored text never meets it. The editor's own limits are only a convenience; this is the control.

A public renderer (issue 16) must still parse only this subset and never
evaluate MDX.
"""

import re

PHOTO_ATTRIBUTES = ("image", "alt", "caption", "credit")

# A value: no raw `"`, `<`, `>`; `&` only as part of an entity.
_VALUE = r'(?:[^"<>&]|&(?:[A-Za-z][A-Za-z0-9]*|#[0-9]+|#[xX][0-9A-Fa-f]+);)*'
_ATTR = rf'[A-Za-z_][\w-]*="{_VALUE}"'
_TAG = re.compile(rf"<Photo((?:[ \t]+{_ATTR})*)[ \t]*/>")
_ATTR_NAME = re.compile(r'([A-Za-z_][\w-]*)="')
_ESM_LINE = re.compile(r"^[ \t]*(?:import|export)\b", re.MULTILINE)
# An opening `<` or `{` that is not backslash-escaped.
_RAW_LT = re.compile(r"(?<!\\)<")
_RAW_BRACE = re.compile(r"(?<!\\)\{")


def content_problems(content: str) -> list[str]:
    """Why this body is not allowed; empty when it is."""
    problems: list[str] = []

    def keep_valid(match: re.Match[str]) -> str:
        names = _ATTR_NAME.findall(match.group(1))
        # The editor writes all four; earlier or hand-written tags may omit caption or credit.
        if (
            len(set(names)) != len(names)
            or not set(names) <= set(PHOTO_ATTRIBUTES)
            or not {"image", "alt"} <= set(names)
        ):
            problems.append(
                "a Photo tag may only have the attributes image, alt, caption and credit,"
                " each once, with image and alt present"
            )
        return "\n"

    rest = _TAG.sub(keep_valid, content)
    if _ESM_LINE.search(rest):
        problems.append("import and export lines are not allowed")
    if _RAW_LT.search(rest):
        problems.append("only Photo tags are allowed; other tags and raw HTML are not")
    if _RAW_BRACE.search(rest):
        problems.append("expressions in braces are not allowed")
    return list(dict.fromkeys(problems))
