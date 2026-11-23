# Tala Kenya web lending

The private Site has an online credit application at `/apply`, account verification at `/verify`, and a reviewer workspace at `/review`. Account verification uses Africa’s Talking for SMS and Didit for hosted identity checks. The sample borrower workspace at `/borrow` uses fictional identities, terms, credit decisions and payments.

## Run and verify

Use Node.js 22 or later.

```sh
npm ci
npm test
npm run dev
```

Open `http://127.0.0.1:8175/verify` for the verification page or `http://127.0.0.1:8175/borrow` for sample borrowing. The loopback preview uses a sample owner and a fresh local D1 database on each run. The private Site derives the owner from its authenticated Sites identity. Tests cover SMS challenge handling, Didit session binding, duplicate requests, failed transfers, repayments and the CaaS contract.

## Supabase database

The migration in `supabase/migrations` creates the Postgres tables for borrower accounts, verification, SMS limits, applications, and reviewer contact access. Tables are in the private `tala_private` schema. The Site calls fixed database functions from `tala_api`. Those functions are available to the backend service role only.

Link the Supabase CLI to the intended project, review the pending migration with `supabase db push --linked --dry-run`, and apply it with `supabase db push --linked`. In the hosted project's Data API settings, add `tala_api` to the exposed schemas. Keep `tala_private` outside that list.

Set these values in the Site's server runtime settings:

| Variable | Value |
| --- | --- |
| `SUPABASE_URL` | The project's HTTPS URL, such as `https://projectref.supabase.co` |
| `SUPABASE_SECRET_KEY` | The project's backend `sb_secret_` key |
| `TALA_DATABASE` | Set to `supabase` after the migration and API setup are verified |

The Site uses D1 by default. If switching an existing deployment, inventory and copy its data before enabling the Supabase backend. Stop writes during the final copy and verify the row counts before reopening intake. Keep the existing application encryption and OTP signing keys so migrated records remain usable.

- [Supabase migration deployment](https://supabase.com/docs/guides/deployment/database-migrations)
- [Exposing a custom API schema](https://supabase.com/docs/guides/api/using-custom-schemas)

## Borrower signup and sign-in

`/signup` verifies a Kenyan mobile number by SMS, then asks the borrower to create and confirm a four-digit web PIN. The same phone verification follows the account to `/verify` for Didit identity checks and then to `/apply`. Returning borrowers use `/signin` with their registered mobile number and web PIN. Web sign-in adds an SMS code before issuing a session.

`/forgot-pin` checks the submitted ID number against the web account's approved Didit result and sends a temporary SMS code. Completing recovery invalidates the account's existing sessions. Borrowers who have yet to verify their ID can use Tala support. The Android account uses Tala’s own identity service. Existing Android account linking requires Tala's approved integration.

Set `TALA_BORROWER_AUTH=web` and supply `TALA_BORROWER_AUTH_KEY` as a base64url-encoded 32-byte secret in the server runtime. Apply the database migrations and configure SMS first. Configure Didit to enable identity verification and PIN recovery. Store the keys in runtime secrets. Staff review uses Sites authentication and the reviewer allowlist.

- [Tala Kenya registration and SMS verification](https://tala.co.ke/loan-app-help/loan-application-process/)
- [Tala Kenya PIN recovery](https://tala.co.ke/faq/)

## Account verification

Configure runtime variables in the Site’s secret settings. Use provider test credentials with `VERIFICATION_ENV=sandbox`. For production, use Tala-approved provider accounts and `VERIFICATION_ENV=live`. Test and live provider applications should have separate API keys and data.

| Variable | Value |
| --- | --- |
| `VERIFICATION_ENV` | `sandbox` or `live` |
| `AT_SMS_USERNAME` | `sandbox` for the SMS simulator, or the live Africa’s Talking app username |
| `AT_SMS_API_KEY` | Secret API key for that Africa’s Talking app |
| `AT_SMS_SENDER_ID` | Approved transactional sender ID for live SMS. Optional in the sandbox |
| `DIDIT_API_KEY` | Secret Didit key with session creation and decision-read permission for the selected workflow |
| `DIDIT_WORKFLOW_ID` | UUID of the Didit KYC workflow for Kenyan national IDs |
| `OTP_SIGNING_KEY` | Secret generated with at least 32 random bytes. A change invalidates outstanding codes and resets phone-based throttling |
| `TALA_APPLICATION_KEY` | Base64url-encoded 32-byte secret for encrypting the verified phone number on a submitted application. Retain this key while the corresponding records are stored |
| `TALA_REVIEWER_EMAILS` | Comma-separated addresses of authorized reviewers. Reviewers must also have access to the private Site |

If Didit restricts callback domains, allowlist the hosted Site origin in the Didit application. The browser returns to `/verify`. The server checks the decision from Didit itself and matches the session, workflow and opaque customer reference. Phone codes expire after five minutes. The Worker stores keyed hashes, masked phone numbers, consent version and timestamp, and verification status. Didit hosts the document and selfie steps.

- [Didit sandbox and identity test data](https://docs.didit.me/integration/sandbox-testing)
- [Didit create session](https://docs.didit.me/sessions-api/create-session)
- [Didit retrieve a decision](https://docs.didit.me/sessions-api/retrieve-session)
- [Africa’s Talking SMS sandbox](https://help.africastalking.com/en/articles/1170660-how-do-i-get-started-on-the-africa-s-talking-sandbox)

## Verified intake and review

The application becomes available once phone and identity providers, the application encryption key and an authorized reviewer are configured. The borrower verifies their phone and identity, confirms their consent, and submits the requested amount and purpose. The server rechecks the Didit decision and matches the entered number against the verified phone. The applicant receives a durable reference and status.

The staff queue shows masked contact details and the Didit session reference. Opening a full contact number creates an audit record. Starting a review changes the applicant’s status to under review. The queue records applications for manual review. Credit decisions, offer acceptance, lending and M-PESA settlement are handled separately by Tala.

## Tala integration

`server/caas.mjs` is a server-side client for the documented Tala Credit-as-a-Service API. It implements the client credentials exchange and the documented opt-in, identity and survey, offer, quote, v2 offer decision, payment notifications, balance, and history routes. `npm run caas:check` performs a read-only connectivity check once these variables have been configured securely:

- `TALA_CAAS_BASE_URL`
- `TALA_CAAS_CLIENT_ID`
- `TALA_CAAS_CLIENT_SECRET`

The sample workspace uses `server/sample-lending.mjs`. Before launching real credit, connect the verified customer identity to Tala CaaS and complete the Kenya web product configuration below.

| Pipeline | What Tala needs to provide or confirm |
| --- | --- |
| Customer authentication and existing accounts | The approved web identity and OTP provider, and the mapping from verified web accounts to the same borrower IDs as the Android app. CaaS OAuth authenticates the partner server. |
| KYC and underwriting | The approved Kenya web onboarding data and consent requirements, and a browser-compatible underwriting path for new customers. The public CaaS no-transactional-data flow may request Android device signals. |
| Terms and servicing | Web credit agreements, offer terms, borrower disclosures, and the servicing, support and referrals contracts for existing Tala Kenya accounts. Offers and balances need to come from Tala’s authoritative records. |
| M-PESA | The approved CaaS and Safaricom settlement arrangement, including sandbox payment rails, merchant identifiers, authenticated confirmations, stable transaction references and reconciliation rules. The documented CaaS notification endpoints report results from partner payment rails. |

### Official references

- [Tala CaaS quick start](https://docs.tala.co/#/quick-start)
- [Tala CaaS API reference](https://docs.tala.co/#/api-reference)
- [Tala CaaS onboarding requirements](https://docs.tala.co/#/api-reference/get-onboarding-requirements)
- [Tala CaaS payment notifications](https://docs.tala.co/#/webhooks)
- [Safaricom Daraja developer portal](https://developer.safaricom.co.ke/)
- [Tala Kenya’s published application instructions](https://tala.co.ke/loan-app-help/loan-application-process/)
