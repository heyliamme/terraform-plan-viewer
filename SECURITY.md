# Security policy

Plans hold secrets: passwords, keys, connection strings. The extension reads plans you
open, runs `terraform` or `tofu` to read binary plans and to run a plan when you ask, and
renders the result in a webview. Bugs that let plan content run script in that webview,
show a sensitive value that should be masked, write or send plan content anywhere, run a
binary a workspace chose, or make `terraform` do anything other than `show -json` and
`plan -out` are taken seriously.

## Reporting

Please report vulnerabilities privately through
[GitHub security advisories](https://github.com/heyliamme/terraform-plan-viewer/security/advisories/new),
not public issues. Include steps to reproduce. You should hear back within a week.

## Scope

In scope: script execution or HTML injection from plan content (addresses, attribute names,
values, diagnostics), sensitive values shown unmasked where they shouldn't be (Copy as
Markdown included), argument injection into the binaries through settings or file names,
anything that runs in Restricted Mode that shouldn't, and anything that sends or stores
plan content.
