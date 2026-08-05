import React from 'react';
import { useLocation } from 'wouter';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import * as z from 'zod';
import { useCreateProject, getListProjectsQueryKey } from '@workspace/api-client-react';
import { useQueryClient } from '@tanstack/react-query';
import { PageHeader } from '@/components/ui/page-header';
import { GlassPanel } from '@/components/ui/glass-panel';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Form, FormControl, FormDescription, FormField, FormItem, FormLabel, FormMessage } from '@/components/ui/form';
import { useToast } from '@/hooks/use-toast';
import { ArrowLeft } from 'lucide-react';
import { Link } from 'wouter';

const formSchema = z.object({
  name: z.string().min(1, 'Project name is required'),
  abstract: z.string().optional(),
  domain: z.string().optional(),
  researchQuestion: z.string().optional(),
  humanDecision: z.string().optional(),
  ethicsNotes: z.string().optional(),
  disclosureNotes: z.string().optional(),
  tags: z.string().optional(),
});

export default function ProjectNew() {
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const createProject = useCreateProject();

  const form = useForm<z.infer<typeof formSchema>>({
    resolver: zodResolver(formSchema),
    defaultValues: {
      name: '',
      abstract: '',
      domain: '',
      researchQuestion: '',
      humanDecision: '',
      ethicsNotes: '',
      disclosureNotes: '',
      tags: '',
    },
  });

  const onSubmit = (values: z.infer<typeof formSchema>) => {
    createProject.mutate(
      {
        data: {
          ...values,
          tags: values.tags ? values.tags.split(',').map(t => t.trim()).filter(Boolean) : [],
        }
      },
      {
        onSuccess: (project) => {
          queryClient.invalidateQueries({ queryKey: getListProjectsQueryKey() });
          toast({ title: 'Project created', description: 'Your new research workspace is ready.' });
          setLocation(`/app/projects/${project.id}`);
        },
        onError: () => {
          toast({ title: 'Error', description: 'Failed to create project', variant: 'destructive' });
        }
      }
    );
  };

  return (
    <div className="p-6 md:p-8 max-w-3xl mx-auto w-full">
      <Link href="/app/projects" className="inline-flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground mb-6 transition-colors">
        <ArrowLeft className="w-4 h-4" /> Back to Projects
      </Link>
      
      <PageHeader 
        title="New Project" 
        description="Define the parameters, objectives, and ethical boundaries of your research agenda."
      />

      <GlassPanel className="p-6 md:p-8">
        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-6">
            
            <FormField
              control={form.control}
              name="name"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Project Name *</FormLabel>
                  <FormControl>
                    <Input placeholder="e.g. Synthesis of novel nanobody candidates" className="vls-glass" {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              <FormField
                control={form.control}
                name="domain"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Research Domain</FormLabel>
                    <FormControl>
                      <Input placeholder="e.g. Computational Biology" className="vls-glass" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="tags"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Tags (comma separated)</FormLabel>
                    <FormControl>
                      <Input placeholder="e.g. covid, antibodies, design" className="vls-glass" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>

            <FormField
              control={form.control}
              name="abstract"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Abstract</FormLabel>
                  <FormControl>
                    <Textarea placeholder="Brief overview of the project..." className="vls-glass resize-none min-h-[100px]" {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <div className="pt-6 border-t border-border/40">
              <h3 className="font-display font-semibold text-lg mb-4">Research Context</h3>
              
              <div className="space-y-6">
                <FormField
                  control={form.control}
                  name="researchQuestion"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Primary Research Question</FormLabel>
                      <FormControl>
                        <Textarea placeholder="What is the core question this project seeks to answer?" className="vls-glass resize-none" {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                <FormField
                  control={form.control}
                  name="humanDecision"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Human Decision Supported</FormLabel>
                      <FormControl>
                        <Textarea placeholder="What decision will the human researchers make based on this deliberation?" className="vls-glass resize-none" {...field} />
                      </FormControl>
                      <FormDescription>Reminds the models of their assistive, non-autonomous role.</FormDescription>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </div>
            </div>

            <div className="pt-6 border-t border-border/40">
              <h3 className="font-display font-semibold text-lg mb-4">Governance & Ethics</h3>
              
              <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                <FormField
                  control={form.control}
                  name="ethicsNotes"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Ethics Notes</FormLabel>
                      <FormControl>
                        <Textarea placeholder="Safety considerations, dual-use risks..." className="vls-glass resize-none" {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                <FormField
                  control={form.control}
                  name="disclosureNotes"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Required Disclosures</FormLabel>
                      <FormControl>
                        <Textarea placeholder="Conflict of interest, methodology limits..." className="vls-glass resize-none" {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </div>
            </div>

            <div className="flex justify-end pt-4">
              <Button type="submit" size="lg" disabled={createProject.isPending}>
                {createProject.isPending ? 'Creating...' : 'Create Project'}
              </Button>
            </div>
          </form>
        </Form>
      </GlassPanel>
    </div>
  );
}
