import { app, InvocationContext, Timer } from "@azure/functions";
import axios from "axios";

interface GitHubRepo {
  id: number;
  name: string;
  full_name: string;
  html_url: string;
  description: string | null;
  language: string | null;
  topics: string[];
}

// Function to fetch topics for a specific repository
async function fetchRepoTopics(fullName: string): Promise<string[]> {
  try {
    const url = `https://api.github.com/repos/${fullName}/topics`;
    const response = await axios.get<{ names: string[] }>(url, {
      headers: {
        Accept: "application/vnd.github.mercy-preview+json", // Required for topics
        Authorization: `Bearer ${process.env.GITHUB_TOKEN}`, // Use a GitHub token for authentication
      },
    });
    return response.data.names;
  } catch (error) {
    console.error(`Error fetching topics for repository ${fullName}:`, error);
    return [];
  }
}

// Function to fetch public repositories for a given GitHub username
async function fetchPublicRepos(username: string): Promise<GitHubRepo[]> {
  try {
    const url = `https://api.github.com/users/${username}/repos`;
    const response = await axios.get<GitHubRepo[]>(url, {
      params: {
        type: "public", // Fetch only public repositories
      },
    });

    // Fetch topics for each repository
    const reposWithTopics = await Promise.all(
      response.data.map(async (repo) => {
        const topics = await fetchRepoTopics(repo.full_name);
        return { ...repo, topics };
      })
    );

    return reposWithTopics;
  } catch (error) {
    console.error("Error fetching repositories:", error);
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
    const repos = await fetchPublicRepos(username);
    console.log(`Public repositories for ${username}:`);
    repos.forEach((repo) => {
      console.log(
        `- ${repo.name}: ${repo.description || "No description"} | ${
          repo.full_name
        } | ${repo.language} | ${repo.topics}`
      );
    });
  } catch (error) {
    console.error("Failed to fetch repositories:", error);
  }
}

app.timer("GitHubRepoTrigger", {
  schedule: "0 */5 * * * *",
  handler: GitHubRepoTrigger,
});
