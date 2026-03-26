import os
import sys
import uuid

# Add backend dir to python path
sys.path.append(os.path.join(os.path.dirname(__file__), ".."))

from app.core.security import get_password_hash
from app.db.models import Base, Client
from app.db.session import engine, get_session


def setup_database():
    """Ensures tables exist (does not drop them)."""
    Base.metadata.create_all(bind=engine)


def create_client():
    print("--- OyeChat: Create New SaaS Client ---")

    name = input("Company Name: ").strip()
    if not name:
        print("Error: Company Name is required.")
        return

    email = input("Admin Email: ").strip()
    if not email:
        print("Error: Admin Email is required.")
        return

    password = input("Admin Password: ").strip()
    if not password:
        print("Error: Admin Password is required.")
        return

    api_key_input = input("Custom API Key (Leave blank to auto-generate): ").strip()
    api_key = api_key_input or f"live-{uuid.uuid4().hex[:8]}"

    system_prompt = input(f"System Prompt (Default: 'You are an advanced AI consultant for {name}.'): ").strip()
    if not system_prompt:
        system_prompt = f"You are an advanced AI consultant for {name}. Your goal is to provide accurate, professional, and helpful answers."

    # Hash the password
    hashed_password = get_password_hash(password)

    setup_database()

    with get_session() as session:
        # Check if email or api_key already exists
        existing_email = session.query(Client).filter(Client.email == email).first()
        if existing_email:
            print(f"Error: A client with the email '{email}' already exists.")
            return

        existing_key = session.query(Client).filter(Client.api_key == api_key).first()
        if existing_key:
            print(f"Error: The API key '{api_key}' is already taken.")
            return

        new_client = Client(
            name=name, email=email, hashed_password=hashed_password, api_key=api_key, system_prompt=system_prompt
        )

        session.add(new_client)
        session.commit()

        print("\n✅ Client Added Successfully!")
        print("=====================================")
        print(f"Client ID:      {new_client.id}")
        print(f"Company Name:   {new_client.name}")
        print(f"Admin Login:    {new_client.email}")
        print(f"Admin Password: {password}")
        print(f"Widget API Key: {new_client.api_key}")
        print("=====================================\n")


if __name__ == "__main__":
    create_client()
