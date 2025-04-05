import { app, InvocationContext, Timer } from "@azure/functions";
import axios, { AxiosError } from "axios";
import * as dotenv from 'dotenv';
dotenv.config();

// Validate GitHub token at startup
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const API_BASE_URL = process.env.API_BASE_URL || 'http://localhost:5070';
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
  readme: string;
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
async function fetchReadme(fullName: string, context: InvocationContext): Promise<string> {
  try {
    const url = `https://api.github.com/repos/${fullName}/readme`;
    const data = await makeGitHubRequest(url, context);
    const content = Buffer.from(data.content, 'base64').toString('utf-8');
    return content;
  } catch (error) {
    context.warn(`No README found for repository ${fullName}, using default`);
    return '# Hello, *World*!';
  }
}

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
          const readme = await fetchReadme(repo.full_name, context);
          return { ...repo, topics, readme };
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

interface GitHubRepoAPI {
  id: number;
  name: string;
  fullName: string;
  htmlUrl: string;
  description: string;
  language: string;
  topics: string[];
  readme: string;
}

export async function GitHubRepoTrigger(
  myTimer: Timer,
  context: InvocationContext
): Promise<void> {
  context.log("Timer function processed request.");
  const username = "jvegar";
  
  try {
    // Fetch existing repos from API
    const existingRepos = await axios.get<GitHubRepoAPI[]>(`${API_BASE_URL}/api/github-repos`);
    const existingRepoMap = new Map(existingRepos.data.map(repo => [repo.fullName, repo]));
    
    // Fetch GitHub repos
    const githubRepos = await fetchPublicRepos(username, context);
    
    // Process repos in batches to avoid overwhelming the API
    const BATCH_SIZE = 5;
    const newRepos: GitHubRepo[] = [];
    const updateRepos: { repo: GitHubRepo; id: number }[] = [];
    
    for (const repo of githubRepos) {
      const existingRepo = existingRepoMap.get(repo.full_name);
      if (!existingRepo) {
        newRepos.push(repo);
      } else {
        updateRepos.push({ repo, id: existingRepo.id });
      }
    }
    
    // Add new repos in batches
    for (let i = 0; i < newRepos.length; i += BATCH_SIZE) {
      const batch = newRepos.slice(i, i + BATCH_SIZE);
      await Promise.all(
        batch.map(async (repo) => {
          const apiRepo: GitHubRepoAPI = {
            id: repo.id,
            name: repo.name,
            fullName: repo.full_name,
            htmlUrl: repo.html_url,
            description: repo.description || '',
            language: repo.language || '',
            topics: repo.topics,
            readme: repo.readme
          };
          
          try {
            await axios.post(`${API_BASE_URL}/api/github-repos`, apiRepo);
            context.log(`Added new repo: ${repo.full_name}`);
          } catch (error) {
            context.error(`Failed to add repo ${repo.full_name}:`, error);
          }
        })
      );
    }

    // Update existing repos in batches
    for (let i = 0; i < updateRepos.length; i += BATCH_SIZE) {
      const batch = updateRepos.slice(i, i + BATCH_SIZE);
      await Promise.all(
        batch.map(async ({ repo, id }) => {
          const apiRepo: GitHubRepoAPI = {
            id: repo.id,
            name: repo.name,
            fullName: repo.full_name,
            htmlUrl: repo.html_url,
            description: repo.description || '',
            language: repo.language || '',
            topics: repo.topics,
            readme: repo.readme
          };
          
          try {
            await axios.put(`${API_BASE_URL}/api/github-repos/${id}`, apiRepo);
            context.log(`Updated repo: ${repo.full_name}`);
          } catch (error) {
            context.error(`Failed to update repo ${repo.full_name}:`, error);
          }
        })
      );
    }
    
    context.log(`Processed ${githubRepos.length} repositories. Added ${newRepos.length} new repos, Updated ${updateRepos.length} existing repos.`);
    
  } catch (error) {
    context.error("Failed to process repositories:", error);
  }
}

app.timer("GitHubRepoTrigger", {
  schedule: "0 */5 * * * *",
  handler: GitHubRepoTrigger,
});
