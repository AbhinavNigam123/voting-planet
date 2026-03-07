# Panther Creek Talent Show Voting App

A real-time voting and feedback system for school talent shows.

## Setup

1. Install dependencies: `npm install`
2. Set environment variable: `ADMIN_PASSWORD=your-secret-password`
3. Run: `npm start`

## Deployment (Fly.io)

1. Install Fly CLI: `flyctl install`
2. Login: `flyctl auth login`
3. Launch: `flyctl launch`
4. Set secret: `flyctl secrets set ADMIN_PASSWORD=your-secret-password`
5. Deploy: `flyctl deploy`

## Features

- Real-time performance updates via SSE
- Ranked voting system (1st-5th place)
- Superlative voting
- Performance feedback collection
- Admin panel for show control
- Media uploads during performances
