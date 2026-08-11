# QA review

Every pull request records a QA review before it merges. The `qa-review` required
check enforces the *recording*: it passes only when the pull request carries a
comment in the format below, stamped with the pull request's current head SHA,
posted by someone with write access. This file is the canonical instruction set.
The failing check links here, so a reviewer — human or agent — picking up a red
pull request starts on this page.

Be clear about what the gate proves. It proves a structured review was recorded
for exactly this code, and nothing more. It cannot tell a rigorous review from a
rubber stamp; that stays with the people reading the comment trail. The gate
exists because the alternative failed quietly: a review that silently never ran
looked identical to a review that passed.

## Running the review

Run the review from a session that did not produce the change. A fresh context
reads the diff as a stranger, which is the point; the author's session grading
its own work loses most of the value. The gate cannot verify this, so it is a
rule rather than a check — but the `Exercised` line is public record, so say
what you were.

1. **Verify the pull request body against the diff.** The title and body become
   the permanent squash commit message. Every claim in it — "existing calls are
   unaffected", "a test pins X" — is a claim to check, not to trust.
2. **Run the gate commands locally where the platform allows**: `npm run
   format:check`, `npm run lint`, `npm run typecheck`, `npm test`, and `go build
   ./... && go test ./...` in `go-core/`. CI runs these too; running them
   yourself catches the platform-specific cases CI's matrix missed.
3. **Review the diff for correctness first**, then conventions:
   - stderr-only logging — a stray `console.log` corrupts the MCP channel;
   - strict ESM with `.js` import extensions;
   - new or renamed tools registered in `src/core/tool-tiers.ts` and
     `src/core/tool-groups.ts`;
   - no Pro tool names in CE-shipped code or docs (the leak-guard classes in
     `tests/integration/build-output.test.ts`);
   - comments that explain constraints, not process or project history;
   - a test for anything behavioral.
   The relevant deep rules live in [`docs/engineering/`](../docs/engineering/);
   read the one covering the area the diff touches.
4. **Check the base.** A branch cut days behind `dev` can undo recent work in
   files that auto-merge cleanly, where no conflict will ever surface it. Diff
   against current `dev`, not just the merge base.
5. **Post the comment.** If there are findings that matter, push the fixes (or
   have the author push them), which moves the head and re-arms the gate — then
   review the new head and post again.

## The comment format

```markdown
### QA review

QA-Reviewed: <full 40-character head SHA>
Verdict: pass
Exercised: npm test/lint/typecheck on macOS 15; full diff reviewed against docs/engineering/tool-design.md

Findings:
- none
```

Field rules, with the machine-checked parts marked:

- `### QA review` — the heading the workflow searches for. *(checked)*
- `QA-Reviewed:` — the full 40-character SHA of the head commit you reviewed.
  Full length on purpose: a short hash pasted from the wrong terminal passes a
  prefix match. *(checked, must equal the current head)*
- `Verdict:` — `pass`, or `findings-addressed` when this review covers the head
  produced by fixing the previous round's findings. *(checked)*
- `Exercised:` — one line: what you ran, on what platform, and what you read.
  An honest "tests only, no manual pass" is fine; an empty line is not.
  *(checked non-empty; content is on your honor)*
- `Findings:` — what you found, or `- none`. Findings that did not block the
  verdict still belong here; they are the record the next reviewer builds on.
  *(judgement, not checked)*

Everything the workflow checks mechanically is listed above; if you change the
format here, change the parser in `.github/workflows/qa-review.yml` in the same
commit.

## Exemptions

Dependabot's grouped minor/patch bumps pass automatically. They are gated by CI
and by the pinned-majors policy in `dependabot.yml`, and a hand-posted comment
on every routine bump would train everyone to paste without reading.

## Enforcement

The workflow reports a commit status named `qa-review`. Blocking merges
requires that name in the `dev` ruleset's required status checks — the workflow
file cannot add itself there. If the status name ever changes, update the
ruleset in the same breath, or the gate silently stops gating.
