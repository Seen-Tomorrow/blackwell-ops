import { Component, type ErrorInfo, type ReactNode } from "react";

interface ErrorBoundaryProps {
  children: ReactNode;
}

interface ErrorBoundaryState {
  hasError: boolean;
  message: string;
}

export default class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { hasError: false, message: "" };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { hasError: true, message: error.message || "Unknown error" };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("[ErrorBoundary]", error, info.componentStack);
  }

  private handleReload = () => {
    window.location.reload();
  };

  render() {
    if (!this.state.hasError) {
      return this.props.children;
    }

    return (
      <div className="err-fallback flex h-screen w-screen items-center justify-center p-8">
        <div className="eink-panel max-w-md w-full rounded-sm p-6 text-center space-y-4">
          <h1 className="err-title text-sm font-mono tracking-widest uppercase">
            Application Error
          </h1>
          <p className="err-body type-body font-mono leading-relaxed">
            Blackwell Ops encountered an unexpected error. Reload to recover.
          </p>
          {__BUILD_MODE__ === "dev" && this.state.message ? (
            <pre className="err-detail text-left type-label font-mono p-3 rounded-sm overflow-x-auto whitespace-pre-wrap break-all">
              {this.state.message}
            </pre>
          ) : null}
          <button
            type="button"
            onClick={this.handleReload}
            className="err-reload px-4 py-2 text-xs font-mono tracking-wider border transition-colors rounded-sm"
          >
            RELOAD APP
          </button>
        </div>
      </div>
    );
  }
}