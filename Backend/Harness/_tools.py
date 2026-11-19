"""
Agent Tool Declarations & Schemas
---------------------------------
Defines the tool specifications exposed to the LLM (Gemini / OpenAI).
Each tool has a strict name, description, and parameter schema.
"""

# Tool declarations formatted for Google Gemini / OpenAI function calling
AGENT_TOOLS = [
    {
        "name": "create_file",
        "description": "Creates or completely overwrites a file at the specified path inside the workspace.",
        "parameters": {
            "type": "OBJECT",
            "properties": {
                "path": {
                    "type": "STRING",
                    "description": "Relative file path inside the workspace (e.g., 'src/main.py' or 'tests/test_app.py')."
                },
                "content": {
                    "type": "STRING",
                    "description": "The exact full text content to write into the file."
                }
            },
            "required": ["path", "content"]
        }
    },
    {
        "name": "read_file",
        "description": "Reads and returns the contents of a file inside the workspace.",
        "parameters": {
            "type": "OBJECT",
            "properties": {
                "path": {
                    "type": "STRING",
                    "description": "The path of the file to inspect."
                }
            },
            "required": ["path"]
        }
    },
    {
        "name": "run_command",
        "description": "Executes a shell command inside the sandbox terminal (e.g., 'pytest', 'python app.py', 'pip list').",
        "parameters": {
            "type": "OBJECT",
            "properties": {
                "command": {
                    "type": "STRING",
                    "description": "The shell command to run inside /workspace."
                }
            },
            "required": ["command"]
        }
    },
    {
        "name": "get_git_diff",
        "description": "Returns the unified git diff of all modifications made to the repository so far.",
        "parameters": {
            "type": "OBJECT",
            "properties": {},
            "required": []
        }
    },
    {
        "name": "finish_task",
        "description": "Signals that the task is finished, tests pass, and provides a final summary of changes.",
        "parameters": {
            "type": "OBJECT",
            "properties": {
                "summary": {
                    "type": "STRING",
                    "description": "Detailed explanation of the root cause, fix, and verification results."
                }
            },
            "required": ["summary"]
        }
    },
      {
        "name": "get_weather",
        "description": "Fetches current weather and forecast for any city or location.",
        "parameters": {
            "type": "OBJECT",
            "properties": {
                "location": {
                    "type": "STRING",
                    "description": "City name or location (e.g., 'San Francisco', 'London', 'Tokyo')."
                }
            },
            "required": ["location"]
        }
    },
]
