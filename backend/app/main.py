from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.routers import simulation, telemetry, export_logs, multi_user

app = FastAPI(
    title="Predictive 5G Handover System API",
    description="Backend for the predictive 5G handover system with predictive beamforming and handover log export.",
    version="1.1.0",
)

# Allow the Next.js dev server (port 3000) and any other origin during development
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Register routers
app.include_router(simulation.router, tags=["Simulation"])
app.include_router(telemetry.router, tags=["Telemetry"])
app.include_router(export_logs.router, tags=["Export"])
app.include_router(multi_user.router, tags=["MultiUser"])


@app.get("/")
def read_root():
    return {"message": "Welcome to the Predictive 5G Handover System API"}


@app.get("/health")
def health_check():
    return {"status": "ok"}
