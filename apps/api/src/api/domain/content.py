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
# Real ESM syntax at the start of a line, not prose that begins with "import".
_ESM_LINE = re.compile(
    r"""(?:^|[\r\n])[ \t]*(?:import\s*(?:[\w$*{][^\n]*?\s+from\s*)?['"]"""
    r"""|export\s*[*{]|export\s+(?:const|let|var|function|class|async|default))""",
)
# The same syntax spread over several lines. A block is the lines up to a blank line; one that
# opens with an import or export and holds `from "..."` (or opens with `import "..."`) is ESM,
# however its lines are broken. Prose that merely starts with "import" has no quoted module.
_BLOCK_SPLIT = re.compile(r"(?:\r\n|\r|\n)[ \t]*(?:\r\n|\r|\n)")
_ESM_BLOCK_START = re.compile(
    r"""[ \t]*(?:import(?:\s|['"])|export\s*[*{]"""
    r"|export\s+(?:const|let|var|function|class|async|default)\b)"
)
_FROM_MODULE = re.compile(r"""from\s*['"]""")
_BARE_IMPORT = re.compile(r"""[ \t]*import\s*['"]""")


def _esm_block(text: str) -> bool:
    for block in _BLOCK_SPLIT.split(text):
        if _ESM_BLOCK_START.match(block) and (
            _FROM_MODULE.search(block) or _BARE_IMPORT.match(block)
        ):
            return True
    return False


# A `<` or `{` is refused wherever it appears, even as `\<` or `\{`: a backslash
# can itself be escaped (`\\<` is a literal backslash and a live `<`), so the
# parser's rule is not reimplemented here. The editor's own output never needs
# them: it writes `<` and `{` as entities or drops them.
_RAW_LT = re.compile(r"<")
_RAW_BRACE = re.compile(r"\{")


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
    if _ESM_LINE.search(rest) or _esm_block(rest):
        problems.append("import and export lines are not allowed")
    if _RAW_LT.search(rest):
        problems.append("only Photo tags are allowed; other tags and raw HTML are not")
    if _RAW_BRACE.search(rest):
        problems.append("expressions in braces are not allowed")
    return list(dict.fromkeys(problems))
