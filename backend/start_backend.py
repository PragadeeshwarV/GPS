import os
import subprocess
import sys

def main():
    print("=========================================")
    print(" Predictive 5G Handover - Startup script ")
    print("=========================================")
    print("Available Towers:")
    print("1. TOWER_A (Alpha-Node NR/5G (N))")
    print("2. TOWER_B (Beta-Node NR/5G (NE))")
    print("3. TOWER_C (Gamma-Node NR/5G (E))")
    print("4. TOWER_D (Delta-Node NR/5G (SE))")
    print("5. TOWER_E (Epsilon-Node NR/5G (S))")
    print("6. TOWER_F (Zeta-Node NR/5G (SW))")
    print("7. TOWER_G (Eta-Node NR/5G (W))")
    print("8. TOWER_H (Theta-Node NR/5G (NW))")
    print("9. Auto (Predictive Handover - Default)")
    
    choice = input("Enter the number of the tower you want to select (1-9) [9]: ").strip()
    
    tower_map = {
        '1': 'TOWER_A',
        '2': 'TOWER_B',
        '3': 'TOWER_C',
        '4': 'TOWER_D',
        '5': 'TOWER_E',
        '6': 'TOWER_F',
        '7': 'TOWER_G',
        '8': 'TOWER_H',
    }
    
    selected = tower_map.get(choice, 'AUTO')
    if selected == 'AUTO':
        print("\n=> Selected: AUTO (Predictive Handover enabled)")
    else:
        print(f"\n=> Selected: {selected} (Locked to this tower)")
    
    env = os.environ.copy()
    env["SELECTED_TOWER"] = selected
    
    print("\nStarting backend on http://127.0.0.1:8000...")
    try:
        subprocess.run([sys.executable, "-m", "uvicorn", "app.main:app", "--reload"], env=env)
    except KeyboardInterrupt:
        print("\nShutting down.")

if __name__ == "__main__":
    main()
