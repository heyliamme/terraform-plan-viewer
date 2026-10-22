# Contributing

Thanks for helping. Bug reports, ideas and pull requests are all welcome.

## Reporting a bug

Open an issue with the smallest plan that shows the problem: the JSON from
`terraform show -json plan.tfplan`, or the text of `terraform plan`, with anything private
redacted. For the text reader, the exact lines matter (indentation included), so attach a
file rather than paste into the form if you can. Say what you expected and what you saw.

## Running from source

Node 22 or newer.

```bash
git clone https://github.com/heyliamme/terraform-plan-viewer
cd terraform-plan-viewer
npm install
npm run watch        # rebuilds dist/ on change
```

Then press `F5` in VS Code to start an Extension Development Host with the extension
loaded and the `samples` folder open: `plans/` holds a plan JSON, a binary plan, the
coloured text output of `tofu plan` and a Terraform plan text; `infra/` the configuration
they came from, for jumping to blocks.

## Tests

```bash
npm test
```

- `test/json.test.mjs`: plan JSON, every action, sensitive and unknown values, drift,
  moves, imports, deposed objects, outputs, checks, format versions, what isn't a plan.
- `test/text.test.mjs`: the text reader on the real OpenTofu output with and without
  colour codes, a Terraform 1.x plan with heredocs, nested blocks, drift and a boxed
  warning, CI logs (GitHub Actions, GitLab, Atlantis), truncated input, lines it can't read.
- `test/markdown.test.mjs`, `test/compare.test.mjs`, `test/model.test.mjs`: Copy as
  Markdown, comparing two plans, the view's grouping and filters.
- `test/binary.test.mjs`: telling which tool wrote a binary plan; with `tofu` or `terraform`
  available (on `PATH`, or `TOFU_BIN` / `TERRAFORM_BIN`), that `show -json` on the fixture
  reads the same as its JSON.
- `test/perf.test.mjs`: a generated 20 MB plan with 5,200 resource changes must read in
  under two seconds. It prints the timings.
- `test/manifest.test.mjs`: the extension manifest, the notices, the README.

The fixtures under `test/fixtures/real` were produced by OpenTofu 1.13.1 with the
`hashicorp/local`, `random`, `null` and `time` providers (no cloud account needed); the
configuration is in `samples/infra`. `test/fixtures/handwritten` holds cases those providers
can't produce (deposed objects, drift with an update, a Terraform 0.12 plan, a Terraform 1.x
text plan), written to the documented formats. `test/fixtures/ci` wraps the real text output
the way CI systems do.

## End-to-end tests

`test/e2e/run.mjs` installs the packaged extension into a throwaway VS Code profile and
uses it as a person would: the title button, Reopen With, the Explorer menu, the clipboard,
a plan run, comparing plans, filters, details, masking, jump to HCL, the keyboard, Copy as
Markdown and Reload Window, then opens the workspace again untrusted to check Restricted
Mode. A stub `tofu` stands in for the real binary. VS Code runs headless, so it doesn't
take over your screen. Linux only (it uses Chromium's headless mode), with `code` on your
`PATH` (or set `VSCODE_CLI` and `VSCODE_BIN`):

```bash
npm run test:e2e
E2E_SHOTS=images npm run test:e2e   # also retakes the README screenshots
```

Screenshots of failing steps land in the temporary folder it prints.

## Working on the view in a browser

```bash
npm run build
node harness/preview.mjs test/fixtures/real/changes.json
google-chrome "file://$PWD/out/preview.html?theme=light"
```

## Layout

| Path | |
| --- | --- |
| `src/core/model.ts` | The plan model: resources, attributes, outputs, checks, counts |
| `src/core/json.ts`, `diff.ts` | Plan JSON, and the before/after attribute tree from a change |
| `src/core/text.ts`, `ansi.ts` | The text plan reader and the CI log cleaner |
| `src/core/tfplan.ts` | A look inside a binary plan: which tool and version wrote it |
| `src/core/markdown.ts`, `compare.ts` | Copy as Markdown, comparing two plans |
| `src/binary.ts` | Running `terraform` / `tofu`: `show -json` and `plan -out` |
| `src/hcl.ts` | Finding a resource's block in the `.tf` files |
| `src/view.ts`, `webview/` | The view, shared by the custom editor and the panels |
| `src/editor.ts`, `src/panel.ts` | The custom editor for files; panels for the clipboard, runs and comparisons |
| `src/extension.ts` | Commands and the "is this a plan" context |

`src/core` has no VS Code dependency and is what the unit tests load.

## Pull requests

- Keep each PR to one change, and say why in the description.
- Run `npm run typecheck` and `npm test`.
- For UI changes, include screenshots in light and dark themes.

Maintainers: see [RELEASING.md](RELEASING.md) for how releases are published.

By contributing you agree that your contribution is licensed under the MIT license.
