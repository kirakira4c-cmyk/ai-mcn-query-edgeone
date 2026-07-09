# AI MCN Query Generator on EdgeOne

This directory is the EdgeOne Makers deployment package.

## Console Build Settings

- Root Directory: `edgeone`
- Framework Preset: `Other`
- Install Command: `npm install`
- Build Command: `npm run build`
- Output Directory: `/` or leave default

## Required Environment Variables

Set these in EdgeOne Makers project settings before production deployment:

- `DEEPSEEK_API_KEY`
- `AI_BASE_URL`
- `AI_MODEL`
- `FEISHU_APP_ID`
- `FEISHU_APP_SECRET`
- `FEISHU_BASE_TOKEN`
- `FEISHU_BASE_TABLE_ID`
- `FEISHU_BASE_URL`

## API Routes

- `POST /api/generate`
- `POST /api/expand`
- `POST /api/feishu/export`
