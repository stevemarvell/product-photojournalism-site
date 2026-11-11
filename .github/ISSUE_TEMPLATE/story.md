---
name: User story
about: "Every issue is a user story. Fill in each section: positive acceptance criteria with the unhappy paths included, and the details to complete the work; put any Depends on #<n> lines last."
---

## Persona

_Who this is for — role, not a name. One line._

As a **[persona]**...

## Story

_The classic form: who, what, why._

As a **[persona]**, I want **[capability]**, so that **[benefit]**.

## Acceptance criteria

_Given/When/Then. One block per scenario — add as many as the story needs, including the unhappy paths. Write each **Then** as what is true afterwards, in positive terms, with an observable result (a status code, a visible text, a stored value). Avoid "not", "no longer", "stops", "never" and "without". Cover an unhappy path by stating the outcome that happens instead: "the request is refused with 403 and the draft keeps its text"._

**Scenario: [name]**
- **Given** [context/precondition]
- **When** [action]
- **Then** [expected outcome]

**Scenario: [name]**
- **Given** ...
- **When** ...
- **Then** ...

## Details to complete

_Everything the assignee needs, so nothing has to be looked up or guessed._

_**For a person's task** (label `human`): numbered steps in the order to do them; where to click or what to run; the exact values (names, URLs, scopes, variable names); each command in its own fenced code block, with no leading `$` and no interleaved output; and what to comment back when done. A step that happens in an external tool may link to that tool's documentation instead of reproducing it, saying what to bring back. Where a step needs a secret, say that the person enters it themselves and that it never goes in the repository, an issue or a chat._

_**For an agent's task**: the inputs, values and decisions already made._

_Write "None" if nothing is needed._

1. 

## Tech notes

_Constraints, affected files/modules, dependencies, anything an implementer needs to know before starting that isn't obvious from the acceptance criteria._

## Testing notes

_What proves this: test types needed, edge cases to cover, data/fixtures required, anything that shouldn't be left to "add a test" without specifics._

## References

_Links: related issues/PRs, designs, docs, prior art._

- 

## Images

_Screenshots, mockups, diagrams. Drag-and-drop attaches them inline._
