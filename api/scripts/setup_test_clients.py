import os
import sys
from sqlalchemy.orm import sessionmaker
from sqlalchemy import create_engine
import uuid

# Add backend dir to python path
sys.path.append(os.path.join(os.path.dirname(__file__), ".."))

from app.db.models import Base, Client
from app.db.session import engine, get_session
from app.core.security import get_password_hash

def create_test_data():
    print("Dropping and recreating tables...")
    Base.metadata.drop_all(bind=engine)
    Base.metadata.create_all(bind=engine)
    
    with get_session() as session:
        print("Inserting test clients with admin credentials...")
        client_a = Client(
            name="OyeChat",
            email="admin@oyechat.com",
            hashed_password=get_password_hash("password123"), # In a real app never default weak passwords
            api_key="oyechat-secret-key",
            system_prompt="You are 'Oye', an advanced AI consultant for OyeChat. Be highly professional."
        )
        
        client_b = Client(
            name="Acme Corp",
            email="hello@acmecorp.com",
            hashed_password=get_password_hash("acmepassword"),
            api_key="acme-test-key",
            system_prompt="You are 'AcmeBot', a helpful support agent for Acme Corp. Use a casual tone."
        )
        
        session.add(client_a)
        session.add(client_b)
        session.commit()
        
        print("\n--- TEST CREDENTIALS (for Admin Dashboard) ---")
        print(f"[Client A - {client_a.name}] ID={client_a.id}")
        print(f"   Email: {client_a.email}")
        print(f"   Password: password123")
        print(f"   API_KEY (for Widget): {client_a.api_key}\n")
        
        print(f"[Client B - {client_b.name}] ID={client_b.id}")
        print(f"   Email: {client_b.email}")
        print(f"   Password: acmepassword")
        print(f"   API_KEY (for Widget): {client_b.api_key}\n")

if __name__ == "__main__":
    create_test_data()
