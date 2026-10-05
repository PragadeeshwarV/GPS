# Predictive 5G Handover System

This is a monorepo for the Predictive 5G Handover System.

## Architecture

The system is composed of two main parts:
- **Backend**: A Python-based API server built with FastAPI. It handles the core logic, predictive models, and real-time socket communications.
- **Frontend**: A Next.js (TypeScript) web dashboard built with Tailwind CSS. It visualizes the data using React-Leaflet maps.

### Directory Structure

- `/backend/` - Python FastAPI application
- `/frontend/` - Next.js web application

## Getting Started

### Backend
1. Navigate to the `backend` directory.
2. Create a virtual environment: `python -m venv venv`
3. Activate the virtual environment.
4. Install dependencies: `pip install -r requirements.txt`
5. Run the server using the interactive startup script (which allows you to choose a tower):
   `python start_backend.py`
   Alternatively, run directly: `uvicorn app.main:app --reload`

### Frontend
1. Navigate to the `frontend` directory.
2. Install dependencies: `npm install`
3. Run the development server: `npm run dev`
