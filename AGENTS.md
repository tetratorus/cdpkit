# Repository layout

- Keep maintained toolkit code, reusable utilities, automated tests, and project documentation outside `data/`.
- Put all one-off scripts, ad-hoc investigations, experiments, and non-core engineering work in `data/scripts/`. Do not put them in the repository root or `scripts/`.
- Put private or customer-specific material, downloads, transcripts, exports, caches, generated reports, screenshots, and copied app bundles in `data/`.
- `data/` is gitignored. Never stage or force-add its contents. Do not embed private data in core source, tests, or documentation.
- Reserve `scripts/` for maintained toolkit utilities and automated tests. Make generated output default to `data/`.
- Resolve paths relative to the package or accept them as arguments. Do not hard-code a user's home directory.

# Verification

Run `npm test` after changing toolkit code. Tests must not launch desktop apps or access live accounts.
