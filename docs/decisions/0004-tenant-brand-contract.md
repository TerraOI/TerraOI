# ADR-0004 Tenant brand contract and `tenant_brands` (T-103 prerequisite)

Status: **accepted** for §2–§5 and §7 · Date: 2026-11-07, accepted 2026-11-20 · Deciders: wyu610 ([#62](https://github.com/TerraOI/TerraOI/issues/62), [#65](https://github.com/TerraOI/TerraOI/issues/65), [#188](https://github.com/TerraOI/TerraOI/issues/188)) · Open: #67 (`locale`) only
Plan refs: §4.4 (public brand cache), §3.4 lessons register (line 191), §5.1 (lines 261–273), §6.1 (line 321), §11 F04/F05 (lines 694–695), §16 (line 944), §20.5 (line 1234)

This ADR was written on 2026-11-07 as a proposal and is now **accepted**. The questions it left open are answered (§6), the contract is in [`src/contracts/tenant-brand.ts`](../../src/contracts/tenant-brand.ts), and the schema is the merged `tenant_brands` migration ([`20261116210000_brand_config.sql`](../../supabase/migrations/20261116210000_brand_config.sql), #150, with the host guard from #211). §1–§5 keep their original reasoning; where the as-built result differs from the proposal, an **As built** note says so.

## 1. Context: why a single validated brand object is the only safe choke point

Identity is already being rendered from values nobody validated. The merged sign-in surfaces take a hand-written prop — [`src/components/auth/types.ts:3-12`](../../src/components/auth/types.ts) (`SignInBrand`) — whose only producers on `main` are a hand-written constant in [`src/components/auth/unknown-address-page.tsx:8-17`](../../src/components/auth/unknown-address-page.tsx) — `TERRAOI_BRAND`, TerraOI-branded by a supervisor ruling recorded in that file's own comment — plus inline fixtures in [`src/components/auth/fixtures.ts`](../../src/components/auth/fixtures.ts), including a `data:` URI logo explicitly "for these fixtures only". There is no brand shape in `src/contracts/` (`grep -i brand src/contracts` → nothing) and no brand column anywhere in `supabase/migrations/` — that is the opening fact of #62.

Four rules in the plan have no place to live except one validated object plus the F04 loader:

- the mode is "tenant configuration, never an arbitrary public `?brand=` or cross-customer selector" (§5.1 line 261);
- colors, assets and URLs are validated, contrast is *actually* checked, and unresolved placeholders are rejected (§5.1 line 269; T-103 acceptance lines; §16 white-label row "no unresolved placeholders");
- a brand row for another tenant is "never served or cached under this host" (T-204), and an unknown or brand-less tenant falls back to the platform brand (T-103);
- email identity needs a *verified* sender — "a display name does not establish domain authorization" (§5.1 line 271).

The plan's own lessons register already names the shape: the "`branding.ts` and organization settings" row is the "Central validation/choke point", to be "Expand[ed] to the full `TenantBrand` contract and all customer-visible surfaces; preserve kit mode rules" (§3.4 line 191, the lessons-register row — not §5.1). [FAQ-0001](../FAQ.md) and [brand/README.md](../../brand/README.md) rule 1 make the kit readable only through `src/platform/branding/`. F04 `loadTenantBrand` (§11 line 694) is that loader: "Host-resolved org + config version → safe product identity".

Without it, every new surface (shell, chat empty/error, browser title, manifest, favicon, notification, email) re-invents what a brand is, and each one is a fresh chance to render the wrong company's name or colour. The kit itself warns that a customer-mode review must "Search visible customer output and metadata for unintended TerraOI references" ([WHITE-LABEL.md](../../brand/terraoi-brand-kit/05-guides/WHITE-LABEL.md), acceptance section) — a manual step TerraOI intends to replace with a validated object.

## 2. The `TenantBrand` fields and where each value comes from

Field list fixed by §5.1 line 269 and [T-204](../tasks/T-204-brand-modes.md) ("display and legal names, descriptor, logo, favicon, primary/on-primary/accent colors, attribution, report owner, email sender name, verified sender and reply-to, document prefix, support links, locale, timezone"). "Kit" means [`02-system/brand-config.json`](../../brand/terraoi-brand-kit/02-system/brand-config.json) and [`02-system/tokens.json`](../../brand/terraoi-brand-kit/02-system/tokens.json), read only inside `src/platform/branding/`.

| Field | Kit supplies it? | Source once merged (proposal) |
|---|---|---|
| `mode` | two kit facts, not one: `defaultMode: "terraoi"` is the kit's default (`brand-config.json:3`, set per WHITE-LABEL.md:17), while WHITE-LABEL.md:11 is about the **preview selector** — "The selector is a design review control. Do not expose cross-customer identity switching in a production tenant UI." | tenant configuration row, resolved from the host-resolved organisation; never a query parameter, header or cookie |
| `displayName` | yes for `terraoi` ("TerraOI"); `powered`/`customer` hold the placeholder `"Customer Brand"` | kit constant (platform mode) / tenant row (all other tenants) |
| `legalName` | **no** — the kit has one `name`, no legal-name field | tenant row, supplied at provisioning (F05, §11 line 695) |
| `descriptor` | yes: `"Operational Intelligence"` in all three modes | kit constant default; tenant row if overridden |
| `tagline` | yes | kit constant (platform) / tenant row |
| `logoUrl`, `faviconUrl` | only as **package-relative paths** (`01-identity/svg/terraoi-logo-color.svg`), and `brand/` is never served | open: #62 sub-question 1 (platform asset path convention vs tenant bucket key vs minted URL) |
| `primary`, `onPrimary`, `accent` | yes: `tokens.json` `semantic` block (`#007F78`, `#FFFFFF`, `#A48748`) and the `powered`/`customer` examples (`#183B66`, `#637D99`) | kit constant (platform) / tenant row, each pair contrast-validated at write and read time |
| `attribution` (`showPoweredBy`) | yes — kit AGENTS.md: "Optional attribution is controlled exclusively by `showPoweredBy`" | derived from `mode`, never stored independently |
| `reportOwner` | yes ("TerraOI" / "Customer Brand") | kit constant / tenant row |
| `emailSenderName` | yes | kit constant / tenant row — a display name only |
| `verifiedSender`, `replyTo` | **no** — `emailReplyTo` is `""` in all three modes, and WHITE-LABEL.md: "Reply-to is blank until a real customer address is approved; it is never inferred" | outbound sending configuration, not a free-text tenant field: depends on #64. One correction while we are writing this down: **no sending-domain step exists in [T-004](../tasks/T-004-infrastructure.md) today** — `git grep -in "sender\|SPF\|DKIM"` over that packet at `467f169` returns nothing — and T-204's line "sending-domain setup is a human step in T-004" points at a step that was never written. That is part of why #64 is open, and a brand PR must not assume the domain is verified. No credential field may be representable in the contract |
| `documentPrefix` | yes (`"TOI"`, `"CUSTOMER"`) | kit constant / tenant row |
| `supportLabel` | yes ("Contact your workspace administrator") | kit constant / tenant row |
| `supportUrl` | **no** — the kit has a label, no URL | tenant row; https-only (T-103 negative test) |
| `locale`, `timezone` | **no** — the kit has no locale field | **already on the organisation row**: `organisations.locale` / `.timezone` ([`20261105060000_tenancy_core.sql:25-26`](../../supabase/migrations/20261105060000_tenancy_core.sql)), which §6.1 line 321 also claims. Do not copy them into a brand row: that would create the two sources of truth AGENTS.md §4 and COORDINATION §6 exist to prevent. Format is open in #67 |
| `configVersion` | no | tenant row; the invalidation key §4.4 and F04 both read (§4, §5) |

So the kit is the **platform** brand and a **shape**, not a tenant's data. The five fields it does not supply — legalName, a sender address, supportUrl, locale, timezone — are exactly the ones with no design source, and none is cosmetic: a sender address implies domain verification (#64), `locale` has an unresolved database CHECK (#67), and `legalName` is the value a legal disclosure names (§7).

**As built (#188).** The contract has three types. `PublicBrand` is the pre-sign-in projection: `mode`, `displayName`, `descriptor`, `tagline`, `logoPath`, `faviconPath`, `primary`, `onPrimary`, `accent`, `supportLabel`, `supportUrl`. `TenantBrand` is the full server-side shape: `PublicBrand` plus `legalName`, `reportOwner`, `emailSenderName`, `emailReplyTo`, `documentPrefix` and `configVersion`. `BrandMode` is the mode vocabulary, with `TenantBrandMode` (`powered`, `customer`) for what a row may hold. The asset references are `logoPath` and `faviconPath`, the versioned `<configVersion>/<name>` path that FAQ-0008's route serves, not URLs. The reply-to is `emailReplyTo`, the single mapping of the `email_reply_to` column (ADR-0001); #188 calls it `replyTo`. `showPoweredBy` is derived by `showPoweredByFor(mode)` and never stored. Not representable: any sender address, sending domain or credential (#64, T-105), and `locale` / `timezone` until #67's migration merges, after which they join `PublicBrand` from `organisations`.

## 3. Where the contract lives, and how it maps onto `SignInBrand`

`src/contracts/tenant-brand.ts` as the packets say — a shared path, changed only through this ADR ([COORDINATION.md §2](../COORDINATION.md)), strict Zod like every other contract ([`src/contracts/README.md`](../../src/contracts/README.md): strict objects, no secret field representable, guards cite the plan). It would sit beside [`tenant-context.ts`](../../src/contracts/tenant-context.ts) and reuse [`keys.ts`](../../src/contracts/keys.ts) for the host.

[`src/components/auth/types.ts`](../../src/components/auth/types.ts) is **not edited by the contract PR**. It stays a component-level props shape ("A component-level props shape, not a src/contracts/ type. T-103/T-204 map the validated TenantBrand onto it"), and the mapping is one pure function in `src/platform/branding/`:

| `SignInBrand` (merged) | from `TenantBrand` |
|---|---|
| `name` | `displayName` |
| `tagline` | `tagline` |
| `logoUrl` | validated `logoUrl` (same-origin path or https URL; the fixture `data:` URI is fixture-only) |
| `primary` / `onPrimary` / `accent` | same three, already contrast-validated |
| `showPoweredBy` | derived: `mode === "powered"` |
| `supportLabel` | `supportLabel` |

**As built.** The function is [`toSignInBrand`](../../src/platform/branding/sign-in-brand.ts) (#173). It takes the loader's output, `LoadedBrand` in `src/platform/branding/tenant-brand.ts`: `PublicBrand` stamped with the host it is served on, `showPoweredBy` derived from the mode, and `reportOwner`, `emailSenderName` and `documentPrefix` picked from `TenantBrand`. `logoUrl` is `brandAssetUrl(logoPath)`, and a path that is not versioned becomes `""` (#215).

Fields the component does not use (`legalName`, sender fields, `documentPrefix`, `locale`, `timezone`, `configVersion`) stay out of the props shape on purpose — the surface gets only what it renders. What breaks if the shapes diverge: `SignInBrand` becomes a de-facto third vocabulary (#62 sub-question 2), the merged assertions in [`brand-modes.test.tsx`](../../src/components/auth/brand-modes.test.tsx) and [`fixtures.ts`](../../src/components/auth/fixtures.ts) pin the wrong names, and T-204's "keep the shape identical" instruction (packet Contract section) becomes a manual re-check instead of a compile error. The SQL-to-TypeScript mapping follows [ADR-0001](0001-core-contracts.md): it "happens once, in the scoped RPC that returns the row", and "a packet, view or adapter never introduces a third name for the same fact".

## 4. Candidate schema — a sketch in this ADR, not a migration

**As built.** The schema is typed columns, as sketched, in [`20261116210000_brand_config.sql`](../../supabase/migrations/20261116210000_brand_config.sql), with assets in `tenant_brand_assets`. That migration supersedes the sketch below, which stays as the reasoning record. The decided points: `mode in ('powered', 'customer')` (note 1, option (a)); platform identity is a kit constant with no row; pre-sign-in reads go through `load_public_brand` and `load_public_brand_asset`, and no request role holds a table grant.

No file under `supabase/migrations/`: a timestamp is the daily sync's to claim ([COORDINATION.md §3](../COORDINATION.md): one migration per PR, rename to a fresh timestamp on rebase), and #62 has not yet said which packet owns the table. The sketch below is what that PR would start from, following the merged patterns: `unique (id, organisation_id)` on the parent so a child table's composite FK can never cross tenants ([`20261105070000_knowledge_core.sql:91-109`](../../supabase/migrations/20261105070000_knowledge_core.sql); `projects` does the same at [`20261105060000_tenancy_core.sql:130-134`](../../supabase/migrations/20261105060000_tenancy_core.sql)), and `config_version` with the same meaning as `organisations.policy_revision` (`…tenancy_core.sql:27-29`) — bumped by the write path, deliberately, not by a trigger default. **There is no working precedent to copy, and this ADR must not imply one:** `policy_revision` appears exactly twice in the merged schema — the column at `:29` and a table comment at `:34` — no trigger and no RPC writes it, and not one merged pgTAP file mentions it (`git grep -n policy_revision origin/main -- supabase src` → two hits, both in that one migration). So `config_version` inherits an **unimplemented** convention: whichever packet first reads a version column also owns the bump path and the assertion that it moves.

```sql
-- SKETCH ONLY. Not a migration; no timestamp claimed; blocked on #62.
create table public.tenant_brands (
  id uuid primary key default gen_random_uuid(),
  organisation_id uuid not null,
  -- §5.1 line 261. Whether 'terraoi' may appear in a row at all is open: see the note below.
  -- RECOMMENDED FORM if note 1's option (a) wins: check (mode in ('powered','customer')).
  -- The permissive list below is written that way only so the sketch compiles under either
  -- ruling. Lifting it into a migration without resolving #62 silently chooses the loose variant.
  mode text not null check (mode in ('terraoi', 'powered', 'customer')),
  display_name text not null check (display_name ~ '^\S(.*\S)?$'
    and char_length(display_name) between 1 and 200),
  legal_name text check (legal_name is null or (legal_name ~ '^\S(.*\S)?$'
    and char_length(legal_name) between 1 and 200)),
  descriptor text not null check (char_length(descriptor) between 1 and 120),
  tagline text not null check (char_length(tagline) between 1 and 200),
  -- Asset references. Public path vs bucket key is #62 sub-question 1; the size limit named by
  -- T-103 has no merged constant, so the CHECK below is a length guard only.
  logo_asset text not null check (char_length(logo_asset) between 1 and 500),
  favicon_asset text not null check (char_length(favicon_asset) between 1 and 500),
  primary_color text not null check (primary_color ~ '^#[0-9A-Fa-f]{6}$'),
  on_primary_color text not null check (on_primary_color ~ '^#[0-9A-Fa-f]{6}$'),
  accent_color text not null check (accent_color ~ '^#[0-9A-Fa-f]{6}$'),
  report_owner text not null check (char_length(report_owner) between 1 and 200),
  document_prefix text not null check (document_prefix ~ '^[A-Z][A-Z0-9]{0,11}$'),
  support_label text not null check (char_length(support_label) between 1 and 200),
  support_url text check (support_url is null or support_url ~ '^https://[^[:space:]]+$'),
  -- An unresolved placeholder never reaches a user (§5.1 line 269; §16 line 944).
  constraint tenant_brands_no_placeholder check (
    display_name not like '%{{%' and tagline not like '%{{%'
    and report_owner not like '%{{%' and support_label not like '%{{%'),
  -- The same line 269 also says "Do not permit arbitrary CSS or scripts. Custom names and
  -- instructions are untrusted content", and that half needs a stated home rather than silence.
  -- PRIMARY guard is the loader/writer (T-103): these fields are stored as text and rendered as
  -- text, never interpolated into markup, a stylesheet, a manifest or an href template, and the
  -- contract keeps no style field at all (§3). The CHECK below is a backstop for a writer that
  -- forgets, not the mechanism — the same division of labour as the contrast rule under the table.
  constraint tenant_brands_names_are_plain_text check (
    display_name !~ '[<>]' and descriptor !~ '[<>]' and tagline !~ '[<>]'
    and report_owner !~ '[<>]' and support_label !~ '[<>]'
    and (legal_name is null or legal_name !~ '[<>]')),
  -- Mirrors organisations.policy_revision: bumped on any brand write, read by the cache and F04.
  config_version bigint not null default 1 check (config_version > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint tenant_brands_organisation_fk
    foreign key (organisation_id) references public.organisations (id) on delete cascade,
  unique (organisation_id),          -- ASSUMPTION, not decided here: one row, updated in place.
                                     -- A versioned/immutable brand history would instead be
                                     -- unique (organisation_id, config_version), and plan :321's
                                     -- "validated configuration/version" wording allows either.
  unique (id, organisation_id)       -- so a later child table can never reference another tenant's
);

-- Contrast is NOT a CHECK: contrast is computed from a colour pair, which SQL cannot do honestly.
-- It is validated by the loader/writer (T-103 negative test) and re-checked on read.

alter table public.tenant_brands enable row level security;  -- enabled, not FORCEd, as in the
                                                             -- merged migration's RLS header note

-- Signed-in members: the same scoped predicate every other tenant-configuration table uses
-- (compare tenant_domains_member_read, tenancy_core.sql:277-282). No anon policy on the table.
create policy tenant_brands_member_read on public.tenant_brands
  for select to authenticated
  using (
    public.is_active_member(organisation_id)
    and organisation_id = public.current_organisation_id()
  );

-- Pre-sign-in presentation comes from one narrow SECURITY DEFINER function, the same shape as
-- resolve_tenant_host (tenancy_core.sql:234-249): the host argument is normalized inside, and it
-- returns a projection, never the row. Pinned search_path is required by 000_guardrails.test.sql.
-- legal_name, config_version and any sender column are deliberately absent from this projection.
create or replace function public.load_public_brand(p_host text)
returns table (mode text, display_name text, descriptor text, tagline text,
               primary_color text, on_primary_color text, accent_color text,
               logo_asset text, favicon_asset text, support_label text, support_url text)
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  if p_host is null or p_host <> lower(btrim(p_host)) or p_host ~ '[[:space:]:/]' then
    raise exception 'host must be a normalized bare hostname' using errcode = '22023';
  end if;
  return query
    select b.mode, b.display_name, b.descriptor, b.tagline, b.primary_color,
           b.on_primary_color, b.accent_color, b.logo_asset, b.favicon_asset,
           b.support_label, b.support_url
      from public.tenant_domains d
      join public.organisations o on o.id = d.organisation_id
      join public.tenant_brands b on b.organisation_id = d.organisation_id
     where d.host = p_host                      -- exact host only; no suffix or alias matching
       and d.status = 'active'
       and d.kind = 'tenant'                    -- 'staging' aliases: open, see the notes below
       and o.status = 'active';                 -- suspended tenants get no brand (F28)
       -- STATED DIVERGENCE, not inherited: the merged model this sketch copies filters
       -- `o.status in ('provisioning', 'active')` at tenancy_core.sql:247. A provisioning tenant
       -- has no brand row yet, so this function is narrower on purpose. If #62 wants the same
       -- filter as the tenancy resolver, say so and change both, not one.
end;
$$;

-- The merged blanket revoke (tenancy_core.sql:335) binds only tables that exist when it runs, and
-- Supabase auto-exposes new public tables to anon/authenticated, so this migration revokes by name.
-- The pattern and its warning are written out at 20261106100000_knowledge_uploads.sql:591-596:
-- "per object, never blanket", because re-running the blanket revoke would strip the tenancy grants.
-- revoke all on public.tenant_brands from anon, authenticated;
-- NO table grant to any request role — see the note below the sketch.
-- grant execute on function public.load_public_brand(text) to anon, authenticated;
```

pgTAP negatives: AGENTS.md §4.2 asks for another tenant, another project and a deactivated member. Two of those fit directly — a member of tenant B sees no row for tenant A, and a deactivated member of A sees none — but **there is no project axis on a tenant-level row**, so the honest substitute is the host-negative pair: an unknown, reserved or suspended host gets no row from the public function, and tenant A's row is never returned for tenant B's host. Say that in the PR rather than shipping a fake "another project" test.

Three structural notes the supervisor should see before choosing (#62):

- **The `terraoi`-mode rule cannot be an *inline* CHECK.** A CHECK expression cannot contain a subquery, so "a `terraoi`-mode row may only exist for platform/admin hosts" (#62's comment) needs either (a) `check (mode in ('powered','customer'))` plus platform identity that is a **kit constant with no row at all**, or (b) a trigger that inspects `tenant_domains`, or (c) writes confined to a definer RPC that validates, **or (d) a CHECK calling an immutable helper** — merged migrations already do that (`check (public.data_class_is_valid(data_class))`, [`knowledge_core.sql:101,103`](../../supabase/migrations/20261105070000_knowledge_core.sql)). (d) is narrower than it first looks: a helper that reads `tenant_domains` is not re-validated when *that* table changes, so it constrains the row at write time and nothing else, which is why a cross-table rule still needs (b) or (c). Which one depends on how #62 answers "who owns platform mode".
- **A brand row needs an organisation, and the platform has none.** `organisation_id` is `not null`; `terraoi.app` / `admin.terraoi.app` are a **code constant** in [`src/platform/tenancy/host.ts:29-30`](../../src/platform/tenancy/host.ts), not rows in `tenant_domains` ([`supabase/seed.sql:47-50`](../../supabase/seed.sql) registers only company1/company2), and `tenant_domains.kind` allows `'platform'`/`'admin'` but no merged row uses them. So option (a) above matches the merged schema; (b)/(c) need a platform organisation and seeded platform domain rows first.
- **Alias hosts have no answer yet.** `supabase/seed.sql:49` registers `company1-staging.terraoi.app` (`kind = 'staging'`) against the same organisation, so the sketch above deliberately filters `kind = 'tenant'`: whether a staging alias reads the same brand row, and under which cache key (§5), is undecided and should not be settled inside a brand PR by accident.

**Columns readable before sign-in, on the tenant's own host only** (proposal; the cut itself is #62's "who may read it unauthenticated" sub-question): `mode`, `displayName`, `descriptor`, `tagline`, the three colours, logo/favicon references, `supportLabel`/`supportUrl`. **Never** pre-sign-in: `legalName` unless a disclosure rule requires it (see §7), the sender/reply-to set, `configVersion` (a cache key, not a page fact), and anything membership-derived or user-derived. The F04 result cached per §4.4 must carry none of the "never" columns.

**Why the sketch grants no SELECT on the table to any request role:** RLS restricts **rows**, never columns. A table-wide `grant select … to authenticated` combined with a member-scoped policy would still hand every signed-in member `legal_name`, the sender fields and `config_version` — exactly the columns the paragraph above refuses to expose and §5.3 keeps server-side. So the sketch reads the presentation projection through `load_public_brand` (anon), reads the full row through a member-scoped projection function, and writes only through a definer RPC. This makes the rule enforceable rather than a preference: if #62 decides members should hold a table grant, then the "never" list shrinks, and that has to be said out loud rather than left to the policy body.

## 5. The public brand cache

§4.4 line 253: "Public brand configuration is a separate, hostname-keyed cache with bounded invalidation; do not include membership details in it." F04's input is "Host-resolved org + config version" and its failure rule is "no public customer-mode override or cached foreign brand" (line 694). T-103's cache test: "hostname-keyed, bounded, and contains **no** membership data"; T-204 adds "a configuration-version change invalidates it within the documented TTL" and "a brand row for another tenant is never served or cached under this host".

Proposal, all of which survives #62's options:

1. **Key** = normalized host (taken only from the trusted routed host — which host source that is depends on #55) + `configVersion`. The host is never a lookup hint from a cookie, header or query string (§4.1, [docs/contracts/tenancy-and-context.md](../contracts/tenancy-and-context.md)).
2. **Bounded**: a fixed entry budget per cache tier with eviction, so an attacker enumerating hostnames cannot grow it without limit.
3. **Contents**: the presentation projection of §4 and nothing else — no `organisationId` in any client-visible form, no membership, no sender fields, no user data. `configVersion` stays server-side.
4. **Invalidation**: the entry is only valid while `configVersion` matches; a bump plus a TTL bounds staleness. The TTL **number** is not fixed by any packet; the packets fix only that a TTL must be documented and that a version change invalidates within it. T-103's staging evidence also requires `Cache-Control` on the brand asset response, which is asset-serving-dependent (#62 sub-question 1).
5. **Tier** (in-isolate vs the Workers `caches` binding) is not decided here; #55's body records what `getCloudflareContext()` exposes. A shared tier widens what a stale entry can affect, so the bound and the TTL matter more there.

## 6. Decisions recorded

1. **#62, ownership and storage.** T-103 owns the table, this contract and this ADR. Mode is `check (mode in ('powered', 'customer'))`, and `terraoi` is the platform constant with no row. `config_version` is bumped by the write path, with a pgTAP assertion. No table grant to `anon` or `authenticated`: the presentation projection comes from one definer RPC keyed by the routed host. SVG and HTML uploads are rejected, not sanitised. A degraded brand logs `brand.fallback` and renders the platform brand.
2. **#65, "TerraOI" in customer mode.** No provider identity, with three categories (§7).
3. **#55, the page host.** [ADR-0006](0006-page-host-via-proxy-header.md): the proxy stamps the routed host, and pages read it from there.
4. **#64, the sender.** The app sends, under T-105. No sender address, domain or credential is in this contract.
5. **#118, assets.** FAQ-0008: the kit is copied into `public/brand/v<kit version>/` at build, and customer assets are served by `GET /brand-assets/{configVersion}/{name}` with immutable caching.
6. **Open: #67, the `locale` CHECK.** `locale` and `timezone` stay out of the contract until its migration merges.

## 7. Brand identity in customer mode (#65)

The rule is **no provider identity**, not "no `terraoi` substring". There are three categories.

1. **Provider identity, never visible in `customer` mode:** the name TerraOI, its wordmark and logo, "Powered by" attribution, TerraOI support or marketing links, the TerraOI favicon, browser titles and social metadata, email sender display names, report and document headers, and export metadata and filenames (brand kit `AGENTS.md:7`; plan §5.1 lines 269–271).
2. **Routing facts, always shown:** the host the user is on (`company1.terraoi.app`) as text, and links to the tenant's own host. Showing the real address lets a user tell the real site from a phishing page (plan §5.1 line 273). An email's sender address domain is a transport fact in this category; its display name is category 1.
3. **Legal facts, only where the law needs them:** the privacy notice and any required processor disclosure may name TerraOI, inside dedicated legal elements only.

**Mechanism.** Routing and legal facts are rendered inside elements marked `data-brand-fact="routing"` or `data-brand-fact="legal"`. The values are `BRAND_FACT_MARKERS` in [`src/contracts/tenant-brand.ts`](../../src/contracts/tenant-brand.ts).

**Test rule.** A customer-mode test removes the marked elements, then asserts no `/terraoi/i` in the remaining HTML, the document title or the favicon `href`. It also asserts that the routing element exists and shows the host, so the test cannot be passed by hiding the host. T-204 rewrites `brand-modes.test.tsx` to this form.

**Not violations.** A degraded brand renders the platform brand and logs `brand.fallback` (#62). The unknown-address page stays TerraOI-branded, because no tenant is known there (PR #20 ruling).

## Consequences

- Both lanes read one vocabulary from `src/contracts/tenant-brand.ts`; `SignInBrand` stays a component projection, and the loader's `LoadedBrand` is built from the contract types rather than declared separately.
- Changing a field in the contract is a contract change: it needs an amendment to this ADR (COORDINATION §2).
- A brand table adds a new row to the merged grant bookkeeping: the blanket `revoke all on all tables in schema public from anon, authenticated;` at [`tenancy_core.sql:335`](../../supabase/migrations/20261105060000_tenancy_core.sql) covers only tables that exist when it runs, so a brand migration carries its own revoke **by name** — the merged precedent, and the reason not to re-run the blanket form, is `20261106100000_knowledge_uploads.sql:591-596` — plus a narrow `grant execute`, and for this table **no table grant at all**, for the column reason stated in §4.
- `T-103`'s packet forbids editing `src/platform/tenancy/`, so the loader cannot extend the merged `TenancyStore` port ([`resolve-tenant-context.ts:37-41`](../../src/platform/tenancy/resolve-tenant-context.ts)); it needs its own query or a new RPC — which is another reason #62, not a builder, decides the storage shape first.
