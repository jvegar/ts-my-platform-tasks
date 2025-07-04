# GitHub Repository Trigger Function

This is an Azure Functions project that implements a GitHub repository trigger function written in TypeScript. The function is designed to respond to GitHub repository events and perform automated actions.

## Project Structure

- `/src` - Source code directory
  - `/functions` - Contains the function implementations
- `/dist` - Compiled JavaScript output
- `/__azurite__` - Local Azure storage emulator data

## Prerequisites

- Node.js (v18 or higher recommended)
- Azure Functions Core Tools (v4.x)
- TypeScript (v4.x)
- Azure CLI (for deployment)

## Installation

1. Clone the repository
2. Install dependencies:
```bash
npm install
```

## Development
1. Build the project:
```bash
npm run build
```

2. Start the function locally:
```bash
npm start
```

3. For development with auto-rebuild:
```bash
npm run watch
```

## Deployment
To deploy to Azure:
1. Login to Azure:
```bash
az login
```

2. Deploy to Azure:
```bash
func azure functionapp publish <function-app-name>
```

## Notes
- The function is scheduled to run every 5 minutes.
- Rate limiting is implemented to avoid hitting GitHub API limits.
- Error handling is included for API responses and rate limits.
- READMEs are fetched and stored for each repository.
- Topics are fetched and stored for each repository.

## License
MIT
