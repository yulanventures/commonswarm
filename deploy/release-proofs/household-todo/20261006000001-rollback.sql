-- Destroys to-do history; the release procedure exports these six tables first.
DROP TABLE IF EXISTS swarm.household_comments;
DROP TABLE IF EXISTS swarm.household_todo_receipts;
DROP TABLE IF EXISTS swarm.household_agent_work_policies;
DROP TABLE IF EXISTS swarm.household_todos;
DROP TABLE IF EXISTS swarm.household_todo_events;
DROP TABLE IF EXISTS swarm.household_todo_streams;
