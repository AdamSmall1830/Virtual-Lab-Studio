import React, { useState } from 'react';
import { useLocation } from 'wouter';
import { SignIn } from '@clerk/react';
import { Loader2 } from 'lucide-react';
import { useSession } from '@/api/session';
import { basePath } from '@/lib/clerk';

/** Development-only fallback: the backend's dev-login (APP_ENV=development). */
function DevSignIn() {
  const { signIn } = useSession();
  const [, setLocation] = useLocation();
  const [email, setEmail] = useState('researcher@virtual-lab.dev');
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSignIn = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email.trim()) return;
    setIsLoading(true);
    setError(null);
    try {
      await signIn(email.trim());
      setLocation('/app');
    } catch {
      setError('Development sign-in failed (only available when APP_ENV=development).');
      setIsLoading(false);
    }
  };

  return (
    <form onSubmit={handleSignIn} className="mt-6 vls-glass rounded-xl p-4 w-[440px] max-w-full">
      <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-2">
        Development sign-in
      </p>
      <div className="flex gap-2">
        <input
          type="email"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          aria-label="Development email"
          className="flex-1 h-10 px-3 rounded-lg bg-background/60 border border-border focus:outline-none focus:ring-2 focus:ring-primary/50 text-sm"
          placeholder="you@lab.dev"
        />
        <button
          type="submit"
          disabled={isLoading}
          className="h-10 px-4 bg-secondary text-secondary-foreground rounded-lg text-sm font-medium hover:bg-secondary/80 disabled:opacity-60"
        >
          {isLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : 'Enter'}
        </button>
      </div>
      {error && (
        <p role="alert" className="mt-2 text-xs text-destructive">
          {error}
        </p>
      )}
    </form>
  );
}

export default function SignInPage() {
  const { isAuthenticated } = useSession();
  const [, setLocation] = useLocation();

  if (isAuthenticated) {
    setLocation('/app');
    return null;
  }

  return (
    <div className="min-h-[100dvh] flex flex-col items-center justify-center p-4 relative overflow-hidden">
      <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_top,_hsl(var(--primary)/0.15),_transparent_50%)]" />
      <div className="relative z-10 flex flex-col items-center">
        {/* path must be the full browser path — Clerk reads window.location.pathname directly */}
        <SignIn routing="path" path={`${basePath}/sign-in`} signUpUrl={`${basePath}/sign-up`} />
        {import.meta.env.DEV && <DevSignIn />}
        <p className="mt-6 max-w-md text-center text-xs text-muted-foreground">
          AI meeting participants are model personas, not human experts. Outputs are decision
          support, not validated conclusions.
        </p>
      </div>
    </div>
  );
}
