# T-131 White-label sign-in components (presentational)

Lane: 1 · Week: 2 · Protected: no · Depends on: T-002
Status: in progress (wyu610)
Plan refs: §4.1 step 3, §4.2 (TOI-ADR-15), §5.1; F02 (presentation only), F04

## Goal
The tenant sign-in screens look right in all three brand modes (`terraoi`, `powered`, `customer`) and show only the methods a tenant has turned on. They are built as **presentational components with no auth logic**. Lane 1 connects them to the real flows in `src/app/(tenant)/login/` under T-102 (magic link), T-201 (password and Microsoft) and T-204 (brand everywhere). Supervisor and Lane 1 agreed this split on 2026-11-05.

Mockup: approved by the supervisor on 2026-11-05: split layout with the brand panel (brand color and contours) and the form panel (logo, "Sign in to <name>", Microsoft, divider, email and magic link, "Use a password instead", support label, optional "Powered by TerraOI").

## Owns (may edit)
- `src/components/auth/` (`types.ts`, `sign-in-page.tsx`, `method-buttons.tsx`, `magic-link-form.tsx`, `password-form.tsx`, `powered-by.tsx`, `no-access-page.tsx`, `check-email-page.tsx`, `unknown-address-page.tsx`) and `src/components/auth/*.test.tsx`
- `src/app/dev/sign-in/page.tsx`: preview of all three modes with fixture brands. It **returns `notFound()` unless `process.env.NODE_ENV === "development"`**.
- `vitest.config.ts` (add the `jsdom` environment for `*.test.tsx`), `package.json` (dev dependencies `@testing-library/react` and `jsdom`)

## Must not edit
`src/app/(tenant)/` and `src/app/auth/` (Lane 1: T-102, T-201, T-204), `src/platform/identity/`, `src/platform/branding/` (T-103 owns the brand loader and the `TenantBrand` contract, which needs an ADR), `src/contracts/`, `brand/`, Lane 2 paths.

## Contract

```ts
// src/components/auth/types.ts. A component-level props shape, not a src/contracts/ type.
// T-103/T-204 map the validated TenantBrand onto it.
export type SignInBrand = {
  name: string;           // "Company1" / "TerraOI"
  tagline: string;
  logoUrl: string;        // same-origin path or https URL only; validated by T-103
  primary: string;        // #RRGGBB
  onPrimary: string;
  accent: string;
  showPoweredBy: boolean; // true only in powered mode
  supportLabel: string;
};
export type SignInMethod = "microsoft" | "magic_link" | "password";
export type SignInStatus =
  | "idle" | "link_sent" | "invalid_credentials" | "rate_limited" | "unavailable";
export type SignInPageProps = {
  brand: SignInBrand;
  enabledMethods: readonly SignInMethod[];  // rendered in this order
  status: SignInStatus;
  magicLinkAction?: (form: FormData) => void | Promise<void>; // React 19 form action from T-102
  passwordAction?: (form: FormData) => void | Promise<void>;  // from T-201
  microsoftHref?: string;                                     // from T-201
};
```

**Rules:**
- **No account probing.** `link_sent` always shows "If this address can sign in, we've sent a link." whatever the input. `invalid_credentials` shows "Email or password is incorrect." The no-access page uses `SAFE_FAILURE_MESSAGE.not_a_member` (T-101).
- **Only enabled methods render.** No disabled buttons. The "or" divider appears only when Microsoft is enabled *and* at least one email method is too. A method whose action or href is missing doesn't render.
- **Customer mode.** When `showPoweredBy` is false, the string "TerraOI" appears nowhere in the rendered HTML (text, `alt`, `aria-*`, `title`, class names). Page `<title>` and favicon are set by T-204's `generateMetadata`; this packet documents that in `src/components/auth/README.md`.
- **Brand colors** apply only as CSS custom properties (`--primary`, `--on-primary`, `--accent`) on the page's top-level element. No `dangerouslySetInnerHTML`. The logo renders as an `<img>` with `alt="<name>"`.
- **Accessibility.** Every input has a `<label>`. Email uses `type="email"`, `autocomplete="username"` and `inputMode="email"`; password uses `autocomplete="current-password"`. Status text lives in an `aria-live="polite"` region. Focus rings are visible, and targets are at least 44 px.
- **Microsoft button** follows Microsoft's sign-in branding: text "Sign in with Microsoft" and the official four-square logo as an inline SVG.
- **Responsive.** Split layout at ≥768 px; below that, the brand panel collapses to a header strip.

## Acceptance tests (write first)
- [ ] positive: with all three methods, Microsoft, the divider, the email form and the password option render in order
- [ ] positive: `powered` brand renders "Powered by TerraOI"; `terraoi` brand renders the TerraOI name and no attribution line
- [ ] negative: `customer` brand: `container.innerHTML` contains no "terraoi" (case-insensitive)
- [ ] negative: only `magic_link` enabled → no Microsoft button, no divider, no password option; `password` listed without `passwordAction` → not rendered
- [ ] negative: `link_sent` renders identical text for two different submitted emails
- [ ] failure: `rate_limited` and `unavailable` render their generic messages in the `aria-live` region; no raw error text is accepted as a prop
- [ ] a11y: every input is reachable by its label (`getByLabelText`); the status region has `aria-live="polite"`
- [ ] the `/dev/sign-in` page calls `notFound()` when `NODE_ENV` is `production`

## Done evidence
`pnpm verify`; the failing test run before the components exist; screenshots of `/dev/sign-in` in all three modes at desktop and mobile widths.

## Out of scope
Auth flows, sessions, cookies, callbacks and server actions (T-102, T-201); loading or validating tenant brands (T-103); metadata, favicon, email templates and error boundaries (T-204); the `TenantBrand` contract and its ADR (T-103).
