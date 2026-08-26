import { useEffect } from 'react';
import * as Sentry from '@sentry/react';
import { isRouteErrorResponse } from 'react-router-dom';
import { t as translateNow } from '../../i18n/i18n';

/**
 * A route error normalized into user-facing copy plus optional technical detail.
 * `status` is present only for router error *responses* (404s, thrown loader
 * `Response`s); a plain render crash has no status.
 */
export interface ParsedRouteError {
  status?: number;
  title: string;
  description: string;
  /** Technical detail (message + stack). Surfaced in dev only - never to users. */
  detail?: string;
}

/**
 * Turn whatever `useRouteError()` returns - a router error response, a thrown
 * `Error`, or an arbitrary value - into consistent, human-readable copy.
 */
export function parseRouteError(error: unknown): ParsedRouteError {
  if (isRouteErrorResponse(error)) {
    const detail = typeof error.data === 'string' && error.data ? error.data : undefined;
    if (error.status === 404) {
      return {
        status: 404,
        title: translateNow('app.pageNotFound') || 'Page not found',
        description: translateNow('app.thisPageDoesntExistOr') || 'This page doesn\'t exist or may have moved.',
        detail,
      };
    }
    if (error.status === 401 || error.status === 403) {
      return {
        status: error.status,
        title: translateNow('app.accessDenied') || 'Access denied',
        description: translateNow('app.youDontHavePermissionTo') || 'You don\'t have permission to view this page.',
        detail,
      };
    }
    return {
      status: error.status,
      title: translateNow('app.somethingWentWrong') || 'Something went wrong',
      description: error.statusText || translateNow('app.thePageFailedToLoad') || 'The page failed to load. Please try again.',
      detail,
    };
  }

  if (error instanceof Error) {
    return {
      title: translateNow('app.somethingWentWrong') || 'Something went wrong',
      description: translateNow('app.anUnexpectedErrorInterruptedThis') || 'An unexpected error interrupted this page. Reloading usually fixes it.',
      detail: `${error.name}: ${error.message}\n\n${error.stack ?? ''}`.trim(),
    };
  }

  return {
    title: translateNow('app.somethingWentWrong') || 'Something went wrong',
    description: translateNow('app.anUnexpectedErrorInterruptedThis') || 'An unexpected error interrupted this page. Reloading usually fixes it.',
    detail: error != null ? String(error) : undefined,
  };
}

/**
 * Report a caught route error to Sentry exactly once. Expected router responses
 * (404 and other 4xx) are noise, so only genuine crashes and 5xx are reported.
 */
export function useReportRouteError(error: unknown): void {
  useEffect(() => {
    const isExpected = isRouteErrorResponse(error) && error.status < 500;
    if (!isExpected) {
      Sentry.captureException(error);
    }
  }, [error]);
}
