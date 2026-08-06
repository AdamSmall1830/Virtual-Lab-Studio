// Clerk wiring shared by App.tsx and the auth pages.
//
// REQUIRED canonical wiring (do not change): the publishable key is resolved
// from window.location.hostname so the same build serves custom domains, and
// the proxy URL env var is empty in dev (Clerk dev FAPI is used directly)
// and auto-populated in production.
import { publishableKeyFromHost } from '@clerk/react/internal';
import { shadcn } from '@clerk/themes';

export const clerkPubKey = publishableKeyFromHost(
  window.location.hostname,
  import.meta.env.VITE_CLERK_PUBLISHABLE_KEY,
);

// PLATFORM CONTRACT (Replit-managed Clerk): VITE_CLERK_PROXY_URL is
// intentionally undefined in development (the Clerk dev instance is reached
// directly) and is injected into the production build environment by the
// deployment system, pointing at the server-side proxy this backend mounts
// at /api/__clerk (backend/app/main.py). Do NOT hardcode that path here and
// do NOT gate on PROD/NODE_ENV — branching breaks the managed prod proxy.
export const clerkProxyUrl = import.meta.env.VITE_CLERK_PROXY_URL;

export const basePath = import.meta.env.BASE_URL.replace(/\/$/, '');

// Clerk passes full paths to routerPush/routerReplace, but wouter's
// setLocation prepends the base — strip it to avoid doubling.
export function stripBase(path: string): string {
  return basePath && path.startsWith(basePath)
    ? path.slice(basePath.length) || '/'
    : path;
}

export const clerkAppearance = {
  theme: shadcn,
  cssLayerName: 'clerk',
  options: {
    logoPlacement: 'inside' as const,
    logoLinkUrl: basePath || '/',
    logoImageUrl: `${window.location.origin}${basePath}/logo.svg`,
  },
  variables: {
    colorPrimary: 'hsl(190 86% 34%)',
    colorForeground: 'hsl(215 35% 14%)',
    colorMutedForeground: 'hsl(215 20% 42%)',
    colorDanger: 'hsl(0 72% 45%)',
    colorBackground: 'hsl(0 0% 100%)',
    colorInput: 'hsl(215 45% 98%)',
    colorInputForeground: 'hsl(215 35% 14%)',
    colorNeutral: 'hsl(215 25% 30%)',
    fontFamily: "'Inter', system-ui, sans-serif",
    borderRadius: '0.75rem',
  },
  elements: {
    rootBox: 'w-full flex justify-center',
    // cardBox must own the surface: card/footer are intentionally transparent.
    cardBox: 'bg-white rounded-2xl w-[440px] max-w-full overflow-hidden shadow-2xl',
    card: '!shadow-none !border-0 !bg-transparent !rounded-none',
    footer: '!shadow-none !border-0 !bg-transparent !rounded-none',
    headerTitle: "font-['Manrope',_'Inter',_sans-serif] text-[hsl(215_35%_14%)] font-bold",
    headerSubtitle: 'text-[hsl(215_20%_42%)]',
    socialButtonsBlockButtonText: 'text-[hsl(215_35%_14%)] font-medium',
    formFieldLabel: 'text-[hsl(215_35%_20%)] font-medium',
    footerActionLink: 'text-[hsl(190_86%_30%)] font-semibold hover:text-[hsl(190_86%_24%)]',
    footerActionText: 'text-[hsl(215_20%_42%)]',
    dividerText: 'text-[hsl(215_20%_50%)]',
    identityPreviewEditButton: 'text-[hsl(190_86%_30%)]',
    formFieldSuccessText: 'text-[hsl(160_60%_30%)]',
    alertText: 'text-[hsl(0_72%_40%)]',
    logoBox: 'justify-center',
    logoImage: 'rounded-xl',
    socialButtonsBlockButton: 'border border-[hsl(215_25%_88%)] bg-white hover:bg-[hsl(215_45%_97%)]',
    formButtonPrimary: 'bg-[hsl(190_86%_34%)] hover:bg-[hsl(190_86%_28%)] text-white font-semibold',
    formFieldInput: 'bg-[hsl(215_45%_98%)] border-[hsl(215_25%_86%)]',
    footerAction: 'justify-center',
    dividerLine: 'bg-[hsl(215_25%_88%)]',
    alert: 'border border-[hsl(0_72%_85%)] bg-[hsl(0_72%_97%)]',
    otpCodeFieldInput: 'border-[hsl(215_25%_80%)] text-[hsl(215_35%_14%)]',
    formFieldRow: 'gap-3',
    main: 'gap-5',
  },
};

export const clerkLocalization = {
  signIn: {
    start: {
      title: 'Welcome back to the Studio',
      subtitle: 'Sign in to your private research workspace',
    },
  },
  signUp: {
    start: {
      title: 'Create your research account',
      subtitle: 'Your own private workspace, ready in seconds',
    },
  },
};
