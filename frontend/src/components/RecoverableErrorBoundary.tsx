import React from 'react';

interface RecoverableErrorBoundaryProps {
  featureName: string;
  onReturnToTraining?: () => void;
  children: React.ReactNode;
}

interface RecoverableErrorBoundaryState {
  error: Error | null;
}

export class RecoverableErrorBoundary extends React.Component<
  RecoverableErrorBoundaryProps,
  RecoverableErrorBoundaryState
> {
  state: RecoverableErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): RecoverableErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo): void {
    console.error(`The ${this.props.featureName} feature failed to render.`, error, errorInfo);
  }

  private retry = (): void => {
    this.setState({ error: null });
  };

  render(): React.ReactNode {
    if (this.state.error) {
      return (
        <div role="alert" className="rounded-xl border border-rose-800 bg-rose-950/40 p-5 text-sm text-rose-200">
          <p className="font-semibold">Could not open {this.props.featureName}.</p>
          <p className="mt-1 text-xs text-rose-300">
            {this.state.error.message || 'An unexpected rendering error occurred.'}
          </p>
          <div className="mt-4 flex flex-wrap gap-2">
            {this.props.onReturnToTraining ? (
              <button
                type="button"
                onClick={this.props.onReturnToTraining}
                className="rounded-lg border border-slate-700 px-3 py-2 text-xs font-semibold text-slate-200 hover:bg-slate-800"
              >
                Return to Training Plan
              </button>
            ) : (
              <button
                type="button"
                onClick={this.retry}
                className="rounded-lg bg-rose-900 px-3 py-2 text-xs font-semibold text-white hover:bg-rose-800"
              >
                Try again
              </button>
            )}
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}

interface LazyFeatureBoundaryProps extends RecoverableErrorBoundaryProps {
  children: React.ReactNode;
}

export const LazyFeatureBoundary: React.FC<LazyFeatureBoundaryProps> = ({
  featureName,
  onReturnToTraining,
  children,
}) => (
  <RecoverableErrorBoundary featureName={featureName} onReturnToTraining={onReturnToTraining}>
    <React.Suspense
      fallback={
        <div role="status" className="rounded-xl border border-slate-800 bg-slate-900/80 p-4 text-xs text-slate-300">
          Loading {featureName}...
        </div>
      }
    >
      {children}
    </React.Suspense>
  </RecoverableErrorBoundary>
);
