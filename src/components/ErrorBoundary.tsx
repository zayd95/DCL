import React, { Component, ErrorInfo, ReactNode } from 'react';
import { AlertCircle, RefreshCw, Home } from 'lucide-react';

interface Props { children?: ReactNode; }
interface State { hasError: boolean; error: Error | null; }

export class ErrorBoundary extends Component<Props, State> {
  public state: State = { hasError: false, error: null };

  public static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  public componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error("Uncaught error:", error, errorInfo);
  }

  private handleReload = () => window.location.reload();
  private handleGoHome  = () => { window.location.href = '/'; };

  public render() {
    if (this.state.hasError) {
      return (
        <div className="min-h-screen bg-surface-page flex items-center justify-center p-6 font-sans">
          <div className="max-w-md w-full bg-surface-card rounded-[32px] p-10 shadow-2xl shadow-brand/10 border border-border-default relative overflow-hidden text-center">
            <div className="absolute -top-24 -right-24 w-48 h-48 bg-status-danger-bg rounded-full blur-3xl opacity-50" />
            <div className="w-20 h-20 bg-status-danger-bg text-status-danger rounded-[24px] flex items-center justify-center mx-auto mb-8 shadow-inner">
              <AlertCircle size={40} />
            </div>
            <h1 className="text-2xl font-black text-brand-dark uppercase tracking-tight mb-4">ERREUR SYSTÈME</h1>
            <p className="text-text-secondary text-body font-medium leading-relaxed mb-10">
              Une erreur inattendue est survenue dans le moteur de DEPOTEK.
              Le cache ou l'état local a peut-être rencontré un conflit critique.
            </p>
            <div className="space-y-4">
              <button
                onClick={this.handleReload}
                className="w-full bg-brand-dark text-white h-14 rounded-2xl flex items-center justify-center gap-3 font-black uppercase tracking-widest text-caption hover:bg-brand transition-all shadow-lg active:scale-95"
              >
                <RefreshCw size={18} /> Récharger l'App
              </button>
              <button
                onClick={this.handleGoHome}
                className="w-full bg-surface-card text-text-muted h-14 rounded-2xl flex items-center justify-center gap-3 font-black uppercase tracking-widest text-caption hover:bg-surface-subtle transition-all border border-border-default"
              >
                <Home size={18} /> Retour Accueil
              </button>
            </div>
            {process.env.NODE_ENV === 'development' && this.state.error && (
              <div className="mt-8 p-4 bg-surface-subtle rounded-xl text-left overflow-auto max-h-40">
                <p className="text-label font-mono text-status-danger leading-tight">
                  {this.state.error.toString()}
                </p>
              </div>
            )}
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
