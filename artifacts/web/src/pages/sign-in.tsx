import React, { useState } from 'react';
import { useLocation } from 'wouter';
import { FlaskConical, ArrowRight, Loader2 } from 'lucide-react';
import { useSession } from '@/api/session';

export default function SignIn() {
  const [, setLocation] = useLocation();
  const { signIn, isAuthenticated } = useSession();
  const [email, setEmail] = useState('researcher@virtual-lab.dev');
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (isAuthenticated) {
    setLocation('/app');
    return null;
  }

  const handleSignIn = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email.trim()) return;
    setIsLoading(true);
    setError(null);
    try {
      await signIn(email.trim());
      setLocation('/app');
    } catch {
      setError('Sign-in failed. The development sign-in is only available in development mode.');
      setIsLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center p-4 relative overflow-hidden">
      <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_top,_hsl(var(--primary)/0.15),_transparent_50%)]" />

      <div className="vls-glass max-w-md w-full p-8 md:p-10 rounded-2xl relative z-10 shadow-2xl border-white/10 dark:border-white/5">
        <div className="flex justify-center mb-8">
          <div className="w-16 h-16 rounded-2xl bg-primary/10 flex items-center justify-center text-primary shadow-inner border border-primary/20">
            <FlaskConical className="w-8 h-8" />
          </div>
        </div>

        <h1 className="text-2xl font-display font-bold text-center mb-2">Welcome to the Studio</h1>
        <p className="text-center text-muted-foreground text-sm mb-8">
          Sign in to your research workspace. Meetings run on the deterministic Demo Provider unless
          a real provider is configured.
        </p>

        <form onSubmit={handleSignIn} className="space-y-4">
          <div>
            <label htmlFor="signin-email" className="block text-sm font-medium mb-1.5">
              Email
            </label>
            <input
              id="signin-email"
              type="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="w-full h-11 px-3 rounded-lg bg-background/60 border border-border focus:outline-none focus:ring-2 focus:ring-primary/50 text-sm"
              placeholder="you@lab.org"
            />
          </div>

          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}

          <button
            type="submit"
            disabled={isLoading}
            className="w-full h-12 bg-primary text-primary-foreground rounded-lg font-semibold flex items-center justify-center gap-2 hover:bg-primary/90 transition-all active:scale-[0.98] disabled:opacity-70 disabled:pointer-events-none shadow-lg shadow-primary/20"
          >
            {isLoading ? (
              <Loader2 className="w-5 h-5 animate-spin" />
            ) : (
              <>
                Enter Workspace
                <ArrowRight className="w-5 h-5" />
              </>
            )}
          </button>
        </form>

        <div className="mt-8 text-center text-xs text-muted-foreground">
          AI meeting participants are model personas, not human experts. Outputs are decision
          support, not validated conclusions.
        </div>
      </div>
    </div>
  );
}
