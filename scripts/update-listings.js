name: Update ATP Listings

on:
  schedule:
    - cron: '0 8 * * *'   # Daily at 8am UTC (3am Panama time) — ATP unlikely to update overnight
  workflow_dispatch:        # Also allows one-click manual trigger from GitHub Actions tab

jobs:
  update:
    runs-on: ubuntu-latest

    steps:
      - name: Checkout repository
        uses: actions/checkout@v4

      - name: Set up Node.js
        uses: actions/setup-node@v4
        with:
          node-version: '20'

      - name: Install dependencies
        run: npm install

      - name: Run listing updater
        run: node scripts/update-listings.js
        env:
          SUPABASE_URL: ${{ secrets.SUPABASE_URL }}
          SUPABASE_ANON_KEY: ${{ secrets.SUPABASE_ANON_KEY }}
