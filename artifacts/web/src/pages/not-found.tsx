export default function NotFound() {
  return (
    <div className="min-h-[100dvh] flex items-center justify-center w-full bg-background p-4">
      <div className="text-center vls-glass p-12 rounded-2xl max-w-md w-full shadow-2xl">
        <div className="text-6xl font-display font-bold text-primary mb-4">404</div>
        <h2 className="text-xl font-semibold mb-2">Page Not Found</h2>
        <p className="text-muted-foreground mb-8 text-sm">
          The research artifact you are looking for has been archived or does not exist.
        </p>
        <a href="/app" className="bg-primary text-primary-foreground px-6 py-2.5 rounded-lg font-medium hover:bg-primary/90 transition-colors inline-block">
          Return to Dashboard
        </a>
      </div>
    </div>
  );
}
