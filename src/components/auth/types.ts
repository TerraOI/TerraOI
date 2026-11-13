// A component-level props shape, not a src/contracts/ type.
// T-103/T-204 map the validated TenantBrand onto it.
export type SignInBrand = {
  name: string; // "Company1" / "TerraOI"
  tagline: string;
  logoUrl: string; // same-origin path or https URL only; validated by T-103
  primary: string; // #RRGGBB; anything else falls back to a neutral color
  onPrimary: string; // #RRGGBB
  accent: string; // #RRGGBB
  showPoweredBy: boolean; // true only in powered mode
  supportLabel: string;
};

export type SignInMethod = "microsoft" | "magic_link" | "password";

export type SignInStatus = "idle" | "link_sent" | "invalid_credentials" | "rate_limited" | "unavailable";

export type SignInFormAction = (form: FormData) => void | Promise<void>;

export type SignInPageProps = {
  brand: SignInBrand;
  enabledMethods: readonly SignInMethod[]; // rendered in this order
  status: SignInStatus;
  /**
   * Magic-link submit target. A string posts to a route handler (preferred for T-102: the handler
   * alone has the edge-delivered `request.url`). A function is a React 19 server action (dev
   * preview / T-201 experiments).
   */
  magicLinkAction?: SignInFormAction | string;
  /** CSRF token closed over by the page; rendered as a hidden field when the action is a URL. */
  csrfToken?: string;
  passwordAction?: SignInFormAction; // from T-201
  microsoftHref?: string; // from T-201
};
