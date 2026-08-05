import React, { useState } from 'react';
import { useListAgents } from '@workspace/api-client-react';
import { PageHeader } from '@/components/ui/page-header';
import { Button } from '@/components/ui/button';
import { AgentCard } from '@/components/ui/agent-card';
import { Plus, Search } from 'lucide-react';
import { Input } from '@/components/ui/input';

export default function AgentStudio() {
  const { data: agents, isLoading } = useListAgents();
  const [search, setSearch] = useState('');

  const filtered = agents?.filter(a => !a.archived && (a.title.toLowerCase().includes(search.toLowerCase()) || a.expertise.toLowerCase().includes(search.toLowerCase()))) || [];

  return (
    <div className="p-6 md:p-8 max-w-7xl mx-auto w-full">
      <PageHeader 
        title="Agent Studio" 
        description="Manage the AI roles that participate in your research meetings."
      >
        <Button>
          <Plus className="w-4 h-4 mr-2" /> Create Agent
        </Button>
      </PageHeader>

      <div className="mb-6 relative max-w-md">
        <Search className="w-4 h-4 absolute left-3 top-3 text-muted-foreground" />
        <Input 
          placeholder="Search agents by title or expertise..." 
          className="pl-9 vls-glass"
          value={search}
          onChange={e => setSearch(e.target.value)}
        />
      </div>

      {isLoading ? (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
          {[1,2,3,4].map(i => <div key={i} className="h-40 bg-muted/50 rounded-xl animate-pulse"></div>)}
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
          {filtered.map(agent => (
            <AgentCard key={agent.id} agent={agent} />
          ))}
          {filtered.length === 0 && <div className="col-span-full py-12 text-center text-muted-foreground">No agents found matching "{search}".</div>}
        </div>
      )}
    </div>
  );
}
