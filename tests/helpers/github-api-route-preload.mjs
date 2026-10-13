// Test-only preload: see github-api-route.mjs.
import { routeGitHubApi } from './github-api-route.mjs';

if (process.env.GITHUB_API_TEST_ROUTE) routeGitHubApi(process.env.GITHUB_API_TEST_ROUTE);
