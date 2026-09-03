# Organic SMM Pro — Final Year Project

> **Built as a Final Year Engineering Project** for academic learning and demonstration purposes.

## Project Overview

Organic SMM Pro is a full-stack Social Media Marketing (SMM) panel built as a final year project to demonstrate real-world web application development. The project covers end-to-end product engineering including authentication, payments, background job scheduling, admin dashboards, and third-party API integrations.

## What I Learned / Topics Covered

- **Full-Stack Development** — React (TypeScript) frontend + Node.js/Express backend
- **Database Design** — PostgreSQL with complex relational schema (users, wallets, orders, transactions)
- **Authentication & Authorization** — Session-based auth with role management (admin / user)
- **Payment Gateway Integration** — ZapUPI (UPI) and OxaPay (crypto) payment flows
- **Background Job Scheduling** — Cron-based organic delivery dispatcher with race-condition handling
- **REST API Design** — Admin and public APIs with middleware, rate limiting, and error handling
- **Third-Party API Integration** — SMM provider APIs with round-robin rotation and retry logic
- **Database Backup & Mirroring** — Automated 6-hour backups with Supabase mirror
- **Responsive UI** — Mobile-first design with Tailwind CSS + shadcn/ui
- **Security** — AES-256-GCM encryption for stored secrets, bcrypt passwords, CSRF protection

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Frontend | React 18, TypeScript, Vite, Tailwind CSS, shadcn/ui |
| Backend | Node.js, Express.js |
| Database | PostgreSQL (Replit managed) |
| Auth | Express sessions + bcrypt |
| Payments | ZapUPI (UPI), OxaPay (USDT) |
| Hosting | Replit |
| Version Control | Git / GitHub |

## Key Features

- **Engagement Order System** — Users place orders for social media engagement (views, likes, saves, shares)
- **Organic Delivery Algorithm** — Randomized, time-distributed delivery that mimics natural growth patterns
- **Multi-Provider Rotation** — LRU-based round-robin across multiple SMM provider API accounts
- **Wallet System** — INR/USD wallet with deposit, transaction history, and admin controls
- **Admin Dashboard** — Real-time stats, order management, provider health monitoring, user management
- **Live Chat Support** — In-app support ticket and chat system
- **Automated Backups** — 6-hourly database backups with 28-day retention

## Project Structure

```
├── src/                    # React frontend (TypeScript)
│   ├── pages/              # Route-level page components
│   ├── components/         # Reusable UI components
│   └── lib/                # Utilities, algorithms, types
├── server/
│   ├── src/                # Express backend
│   │   ├── routes/         # API route handlers
│   │   ├── middleware/      # Auth, validation middleware
│   │   ├── services/       # Business logic services
│   │   └── cron.js         # Background job scheduler
│   ├── migrations/         # SQL migration files
│   └── test/               # Integration tests
└── docs/                   # Project documentation
```

## Running Locally

Requires Node.js 18+ and PostgreSQL.

```sh
git clone https://github.com/s4chizreplit-source/EXTISPBA.git
cd EXTISPBA
npm install
npm run dev
```

## Academic Note

This project was developed as a final year B.Tech/BCA project to demonstrate practical implementation of modern full-stack web development concepts. It integrates real payment APIs, background workers, and a production-grade database schema — topics typically covered across multiple courses (DBMS, Web Technologies, Software Engineering).

---

*Project by — Final Year Student | Computer Science / IT*
