import React from 'react';
import { useLocation } from 'wouter';
import { SignUp } from '@clerk/react';
import { useSession } from '@/api/session';
import { basePath } from '@/lib/clerk';

export default function SignUpPage() {
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
        <SignUp routing="path" path={`${basePath}/sign-up`} signInUrl={`${basePath}/sign-in`} />
        <p className="mt-6 max-w-md text-center text-xs text-muted-foreground">
          Every account gets its own private workspace with a guided demo project.
        </p>
      </div>
    </div>
  );
}
