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
      <div className="flex h-screen w-screen items-center justify-center bg-[#0a0c0f] p-8">
        <div className="eink-panel max-w-md w-full rounded-sm p-6 text-center space-y-4">
          <h1 className="text-sm font-mono tracking-widest text-telemetry-red uppercase">
            Application Error
          </h1>
          <p className="text-[10px] font-mono text-stealth-muted/70 leading-relaxed">
            Blackwell Ops encountered an unexpected error. Reload to recover.
          </p>
          {__BUILD_MODE__ === "dev" && this.state.message ? (
            <pre className="text-left text-[9px] font-mono text-stealth-muted/50 bg-black/30 p-3 rounded-sm overflow-x-auto whitespace-pre-wrap break-all">
              {this.state.message}
            </pre>
          ) : null}
          <button
            type="button"
            onClick={this.handleReload}
            className="px-4 py-2 text-xs font-mono tracking-wider border border-nv-green/40 text-nv-green hover:bg-nv-green/10 transition-colors rounded-sm"
          >
            RELOAD APP
          </button>
        </div>
      </div>
    );
  }
}