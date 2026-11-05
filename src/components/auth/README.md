# Sign-in components (T-131)

Presentational sign-in screens for tenant portals. They contain **no auth logic**: no sessions, cookies, callbacks or provider calls. Lane 1 connects them to the real flows in `src/app/(tenant)/login/` under T-102 (magic link), T-201 (password and Microsoft) and T-204 (brand everywhere).

Preview all three brand modes with `pnpm dev` at `/dev/sign-in`. The route returns 404 in every other environment.

## Components

| Component | Props | Use |
|---|---|---|
| `SignInPage` | `SignInPageProps` (see `types.ts`) | The sign-in screen |
| `CheckEmailPage` | `{ brand }` | After a magic-link request |
| `NoAccessPage` | `{ brand }` | Signed in, but not a member of this workspace |
| `UnknownAddressPage` | none | A host that maps to no tenant. It takes no tenant brand and always shows TerraOI branding (supervisor ruling, PR #20) |
| `MagicLinkForm`, `PasswordForm`, `MicrosoftButton`, `StatusMessage`, `PoweredBy` | | Building blocks used by the pages |

`SignInBrand` is a component-level shape, not a `src/contracts/` type. T-103 and T-204 map the validated `TenantBrand` onto it.

## Wiring (T-102, T-201)

```tsx
// src/app/(tenant)/login/page.tsx (sketch)
import { SignInPage } from "@/components/auth/sign-in-page";
import { requestMagicLink, signInWithPassword } from "./actions"; // "use server"

export default async function Login() {
  const brand = await loadSignInBrand(); // T-103/T-204
  return (
    <SignInPage
      brand={brand}
      enabledMethods={brand.methods}      // the tenant's configured order
      status={statusFromSearchParams()}  // narrow to SignInStatus; unknown values render no message
      magicLinkAction={requestMagicLink}
      passwordAction={signInWithPassword}
      microsoftHref="/auth/microsoft"
    />
  );
}
```

- A method renders only when it is in `enabledMethods` **and** its action or href is passed. Leave one out to hide that method; there are no disabled buttons.
- The "or" divider appears only when Microsoft and at least one email method are both shown.
- Forms post `FormData` with `email` (and `password` for the password form).

## Rules these components enforce

- **No account probing.** Status text comes only from `STATUS_COPY` in `copy.ts`. No prop accepts free error text. `link_sent` reads the same whatever the address.
- **Customer mode.** When `showPoweredBy` is false, "TerraOI" appears nowhere in the rendered HTML. A test checks this.
- **Brand colors** must be `#RRGGBB`; any other value is replaced by a neutral color. They apply only as `--primary`, `--on-primary` and `--accent` on the page root. There's no inline `background-color` and no `dangerouslySetInnerHTML`.
- **Accessibility.** Every input sits inside its `<label>`. Email fields use `autocomplete="username"`, and the password field uses `current-password`. Status text is in a `role="status"` `aria-live="polite"` region that is always mounted. Targets are at least 44 px, and focus rings are visible.

## Left to T-204

The page `<title>` and favicon come from T-204's `generateMetadata`. These components never set them, so customer mode stays free of TerraOI there as well. T-204 also owns email templates and error boundaries.

## Known follow-ups

- `NO_ACCESS_COPY` duplicates `SAFE_FAILURE_MESSAGE.not_a_member` from T-101. Import it from `src/platform/tenancy/` once T-101 is on `main`.
- Fixture logos are inline `data:` SVGs, because there is no `public/` yet (T-103 owns it).
