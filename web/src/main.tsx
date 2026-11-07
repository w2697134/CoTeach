import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider } from 'react-router/dom';
import '@fontsource-variable/inter';
import '@fontsource-variable/jetbrains-mono';
import 'katex/dist/katex.min.css';
import './styles/index.css';
import { preloadPages, router } from './routes';
import { ConfirmProvider, Toaster } from './components/ui';
import { useAuth, useToasts } from './lib/store';
import { resetPrivateSession } from './lib/api';
import { whenIdle } from './lib/idle';

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: { refetchOnWindowFocus: false, retry: 1, staleTime: 15_000 },
  },
});

useAuth.subscribe((state, previous) => {
  if (state.user?.id !== previous.user?.id || state.user?.role !== previous.user?.role) {
    resetPrivateSession();
    queryClient.clear();
    useToasts.setState({ items: [] });
  }
});

useAuth.getState().load();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <ConfirmProvider>
        <RouterProvider router={router} />
        <Toaster />
      </ConfirmProvider>
    </QueryClientProvider>
  </StrictMode>,
);
whenIdle(preloadPages);
