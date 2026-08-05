import React, { useState } from 'react';
import { useLocation } from 'wouter';
import { FlaskConical, ArrowRight, Loader2 } from 'lucide-react';
import { mutate } from '@/demo/store';

export default function SignIn() {
  const [, setLocation] = useLocation();
  const [isLoading, setIsLoading] = useState(false);

  const handleSignIn = () => {
    setIsLoading(true);
    // Simulate network request
    setTimeout(() => {
      mutate((state) => {
        state.onboarded = true;
      });
      setLocation('/app');
    }, 800);
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
          Enter the deterministic demo environment. No real data is sent to external APIs in this build.
        </p>

        <button
          onClick={handleSignIn}
          disabled={isLoading}
          className="w-full h-12 bg-primary text-primary-foreground rounded-lg font-semibold flex items-center justify-center gap-2 hover:bg-primary/90 transition-all active:scale-[0.98] disabled:opacity-70 disabled:pointer-events-none shadow-lg shadow-primary/20"
        >
          {isLoading ? (
            <Loader2 className="w-5 h-5 animate-spin" />
          ) : (
            <>
              Continue to Demo Workspace
              <ArrowRight className="w-5 h-5" />
            </>
          )}
        </button>

        <div className="mt-8 text-center text-xs text-muted-foreground">
          By continuing, you agree to our <span className="underline cursor-pointer">Terms of Service</span> and acknowledge this is a simulation.
        </div>
      </div>
    </div>
  );
}
