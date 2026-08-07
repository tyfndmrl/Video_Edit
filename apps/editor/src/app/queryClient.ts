/**
 * Shared react-query client. A module (not created inside App) so non-React
 * code — e.g. the upload manager invalidating the asset list after a finished
 * upload — can reach it.
 */
import { QueryClient } from '@tanstack/react-query';

export const queryClient = new QueryClient();
