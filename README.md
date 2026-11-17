# ClaimScrub

ClaimScrub checks itemized medical bills for common billing errors.

- `website/` — the three web pages: home page, the bill-checking tool, and the free next-steps guide.
- `claimscrub-server/` — the backend: server-side audit, Stripe payments, and the billing-code importer. See its README.

Licensed code files (such as the AMA CPT data file) must never be added to this repository.
Keep them in `claimscrub-server/licensed-data/`, which is excluded by `.gitignore`.
