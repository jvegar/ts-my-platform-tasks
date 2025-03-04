import { app, InvocationContext, Timer } from "@azure/functions";
import axios, { AxiosError } from "axios";
import * as dotenv from 'dotenv';
dotenv.config();

// Validate GitHub token at startup
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
if (!GITHUB_TOKEN) {
  throw new Error('GITHUB_TOKEN environment variable is not set. Please set it in your .env file or application settings.');
}

interface GitHubRepo {
  id: number;
  name: string;
  full_name: string;
  html_url: string;
  description: string | null;
  language: string | null;
  topics: string[];
}

interface RateLimitInfo {
  limit: number;
  remaining: number;
  reset: number;
}

// Simple in-memory cache
const cache = new Map<string, { data: any; timestamp: number }>();
const CACHE_TTL = 4 * 60 * 1000; // 4 minutes cache (since we run every 5 minutes)

function getRateLimitInfo(headers: any): RateLimitInfo {
  return {
    limit: parseInt(headers['x-ratelimit-limit'] || '0'),
    remaining: parseInt(headers['x-ratelimit-remaining'] || '0'),
    reset: parseInt(headers['x-ratelimit-reset'] || '0') * 1000, // Convert to milliseconds
  };
}

async function makeGitHubRequest(url: string, context: InvocationContext, params = {}) {
  const cacheKey = `${url}${JSON.stringify(params)}`;
  const cached = cache.get(cacheKey);
  
  if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
    return cached.data;
  }

  const maxRetries = 3;
  let retryCount = 0;
  
  while (retryCount < maxRetries) {
    try {
      const response = await axios.get(url, {
        headers: {
          Accept: "application/vnd.github.mercy-preview+json",
          Authorization: `Bearer ${GITHUB_TOKEN}`, // Use the validated token
        },
        params,
      });

      const rateLimit = getRateLimitInfo(response.headers);
      context.log(`Rate limit - Remaining: ${rateLimit.remaining}/${rateLimit.limit}`);

      if (rateLimit.remaining < 100) {
        context.warn(`Warning: GitHub API rate limit is running low. ${rateLimit.remaining} requests remaining.`);
      }

      // Cache the successful response
      cache.set(cacheKey, { data: response.data, timestamp: Date.now() });
      return response.data;

    } catch (error) {
      const axiosError = error as AxiosError;
      
      if (axiosError.response?.status === 401) {
        throw new Error('GitHub API authentication failed. Please check if your GITHUB_TOKEN is valid.');
      }
      
      if (axiosError.response?.status === 403 && axiosError.response?.headers['x-ratelimit-remaining'] === '0') {
        const resetTime = new Date(parseInt(axiosError.response.headers['x-ratelimit-reset'] || '0') * 1000);
        throw new Error(`GitHub API rate limit exceeded. Resets at ${resetTime.toISOString()}`);
      }

      if (retryCount < maxRetries - 1) {
        const delay = Math.pow(2, retryCount) * 1000;
        context.log(`Retrying after ${delay}ms...`);
        await new Promise(resolve => setTimeout(resolve, delay));
        retryCount++;
        continue;
      }

      throw error;
    }
  }

  throw new Error('Max retries exceeded');
}

// Function to fetch topics for a specific repository
async function fetchRepoTopics(fullName: string, context: InvocationContext): Promise<string[]> {
  try {
    const url = `https://api.github.com/repos/${fullName}/topics`;
    const data = await makeGitHubRequest(url, context);
    return data.names;
  } catch (error) {
    context.error(`Error fetching topics for repository ${fullName}:`, error);
    return [];
  }
}

// Function to fetch public repositories for a given GitHub username
async function fetchPublicRepos(username: string, context: InvocationContext): Promise<GitHubRepo[]> {
  try {
    const url = `https://api.github.com/users/${username}/repos`;
    const data = await makeGitHubRequest(url, context, { type: "public" });

    // Process repositories in batches to avoid overwhelming the API
    const BATCH_SIZE = 5;
    const results: GitHubRepo[] = [];

    for (let i = 0; i < data.length; i += BATCH_SIZE) {
      const batch = data.slice(i, i + BATCH_SIZE);
      const batchResults = await Promise.all(
        batch.map(async (repo: GitHubRepo) => {
          const topics = await fetchRepoTopics(repo.full_name, context);
          return { ...repo, topics };
        })
      );
      results.push(...batchResults);
    }

    return results;
  } catch (error) {
    context.error("Error fetching repositories:", error);
    throw error;
  }
}

export async function GitHubRepoTrigger(
  myTimer: Timer,
  context: InvocationContext
): Promise<void> {
  context.log("Timer function processed request.");
  const username = "jvegar";
  try {
    const repos = await fetchPublicRepos(username, context);
    context.log(`Public repositories for ${username}:`);
    repos.forEach((repo) => {
      context.log(
        `- ${repo.name}: ${repo.description || "No description"} | ${
          repo.full_name
        } | ${repo.language} | ${repo.topics}`
      );
    });
  } catch (error) {
    context.error("Failed to fetch repositories:", error);
  }
}

app.timer("GitHubRepoTrigger", {
  schedule: "0 */5 * * * *",
  handler: GitHubRepoTrigger,
});
