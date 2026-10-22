# Changelog

## 0.1.0

First release.

- Opens a Terraform or OpenTofu plan as a readable report: the summary line, a count per
  action, destroyed and replaced resources first, each resource's attributes before and
  after (nested objects and lists, `jsonencode` values opened up, multi-line strings as a
  line diff), the attribute that forces a replacement, why a resource is deleted, replaced,
  moved, imported or forgotten, drift, outputs, and checks and conditions.
- Reads plan JSON (`terraform show -json`, format versions 0.1 to 1.2, OpenTofu too),
  binary `.tfplan` files through `terraform` or `tofu` (the viewer tells which wrote the
  plan), and the text output of `terraform plan` from a file, the clipboard or a CI log,
  with colour codes, GitHub Actions and GitLab decorations and Markdown fences stripped.
  What the text reader can't read is listed, and the `Plan:` line is checked against what
  was read.
- Entry points: a `.tfplan` (or a file named `tfplan`) opens in the viewer by default;
  plan JSON and text through the editor title button, the Explorer menu, Reopen Editor
  With, the Command Palette, Open Plan from Clipboard and Open Plan File. Run Plan and
  Open runs `plan -out` in a folder you pick, with progress and cancel. Compare Terraform
  Plans shows what changed between two runs.
- Filters by action, type and text, destructive only; sensitive values masked and revealed
  one by one; jump to the resource's HCL block (modules followed by their `source`); Copy
  as Markdown (summary table and `<details>` per resource, sensitive values masked) and
  Copy summary; keyboard navigation and an ARIA tree; light, dark and high-contrast themes.
- Plans with thousands of resource changes open in about a second; rows render as you
  scroll and attributes when a resource is opened. Files over 150 MB are refused (two
  compared plans count together).
- Run Plan and Open, when cancelled or past its time limit, interrupts the plan as Ctrl+C
  would and gives it a minute to release the state lock; on Windows it plans with
  `-lock=false`.
- No binary runs in Restricted Mode, and a binary plan isn't looked into there either; the binary path and plan arguments come from user or
  machine settings only; binaries run with an argument list, never a shell; plan content is
  never written, logged or sent. For a plan file, VS Code's view state keeps which
  resources were open and the search text across reloads; for a plan from the clipboard,
  a run or an unsaved editor, it keeps nothing of the plan.
