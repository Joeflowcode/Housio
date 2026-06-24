# Housio Bend Directory Onboarding

Use this when adding local Bend businesses to the directory and reviewing claim requests.

## Add a Public Listing

1. Open `directory-data.js`.
2. Add the business to `window.HOUSIO_DIRECTORY_LISTINGS`.
3. Use only public information from the business website, Google profile, or owner-approved details.
4. Set `status` to `unclaimed` until the owner signs up through Housio.

Example:

```js
{
  name: 'Business Name',
  category: 'house-cleaning',
  city: 'Bend',
  website: 'https://example.com',
  phone: '(541) 555-0100',
  status: 'unclaimed',
  claimSlug: 'business-name',
  notes: 'Recurring and move-out cleaning.',
  sourceUrl: 'https://example.com',
  sourceCheckedAt: '2026-06-24'
}
```

## Review a Claim

When a business owner clicks `Claim profile`, the signup URL includes:

- `claim`: stable listing slug
- `claim_name`: visible business name
- `service`: the service category to preselect

After the schema migration is applied, completed pro onboarding stores those values on the `pros` row:

- `directory_claim_name`
- `directory_claim_slug`
- `directory_claimed_at`

Before marking a listing claimed, verify that the person controls the business website, public phone, or business email.

## Approve a Claim

1. Confirm the owner is legitimate.
2. Update the matching listing in `directory-data.js` from `unclaimed` to `claimed`.
3. Keep the same `claimSlug`.
4. Commit and push the change.

## Remove a Listing

Remove a listing if the business asks to be removed, the contact info is wrong, or the business is not a good fit for Housio.
