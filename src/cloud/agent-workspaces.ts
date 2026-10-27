import {openProfileCredential,type AgentProfile} from './agent-profile.js';
export interface ReachableAgentWorkspace {workspace_id:string;name:string;org_id:string;org_name:string;permissions:{scopes:string[];content_operations:string[]}}
export async function agentWorkspaces(profile:AgentProfile,fetcher:typeof fetch=fetch):Promise<{workspaces:ReachableAgentWorkspace[]}> {
 const credential=await openProfileCredential(profile,fetcher),token=await credential.bearer();
 const response=await fetcher(`${profile.url}/functions/v1/read`,{method:'POST',headers:{apikey:profile.anon_key,authorization:`Bearer ${token}`,'content-type':'application/json'},body:JSON.stringify({resource:'workspaces',workspace_id:profile.workspace_id})});
 if(!response.ok) throw new Error(`Workspace discovery failed (HTTP ${response.status}).`);
 const value=await response.json() as {workspaces?:ReachableAgentWorkspace[]};
 if(!Array.isArray(value.workspaces)) throw new Error('Workspace discovery returned an invalid directory.');
 return {workspaces:value.workspaces};
}
