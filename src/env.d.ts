export interface Env {
  World: DurableObjectNamespace;
  KaleAgent: DurableObjectNamespace;
  AI: {
    run: (model: string, inputs: unknown, options?: unknown) => Promise<any>;
  };
  ASSETS: Fetcher;
}

declare global {
  interface Env {
    World: DurableObjectNamespace;
    KaleAgent: DurableObjectNamespace;
    AI: {
      run: (model: string, inputs: unknown, options?: unknown) => Promise<any>;
    };
    ASSETS: Fetcher;
  }
}

export {};
