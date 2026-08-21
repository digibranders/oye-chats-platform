import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { Alert, Button, Dialog, Field, Input, Textarea, toast } from '../../ui';
import { createDepartment, updateDepartment } from '../../services/api';
import type { Department } from '../../types/domain';
import { BusinessHoursEditor } from './BusinessHoursEditor';
import { invalidDays, normalizeBusinessHours, type BusinessHours } from './businessHours';

export interface DepartmentDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** `null` creates a new department. */
  department: Department | null;
  onSaved: () => void;
}

/**
 * Create or edit a department.
 *
 * Departments carry their own opening hours, which is the only place in the
 * console a schedule is a workspace-level fact rather than a chatbot's: a
 * "Billing" group that answers 9–5 and a "Support" group that answers around
 * the clock are two different promises to the visitor, and the offline-hours
 * resolver reads them from here.
 */
export function DepartmentDialog({
  open,
  onOpenChange,
  department,
  onSaved,
}: DepartmentDialogProps) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [hours, setHours] = useState<BusinessHours | null>(null);
  const [nameError, setNameError] = useState<string | null>(null);

  // Seeded during render on the identity of what is being edited — the
  // department's id, or `new`. An effect would paint the previous department's
  // name for a frame.
  const seed = open ? (department ? String(department.id) : 'new') : null;
  const [seeded, setSeeded] = useState<string | null>(null);
  if (seeded !== seed) {
    setSeeded(seed);
    if (seed !== null) {
      setName(department?.name ?? '');
      setDescription(department?.description ?? '');
      setHours((department?.business_hours as BusinessHours | null) ?? null);
      setNameError(null);
    }
  }

  const save = useMutation({
    mutationFn: async () => {
      const payload = {
        name: name.trim(),
        description: description.trim() || null,
        // Persisted only while the master switch is on. Sending a disabled
        // schedule would store a shape the resolver then has to interpret;
        // `null` is unambiguously "always open".
        business_hours: hours && hours.enabled ? hours : null,
      };
      return department
        ? updateDepartment(department.id, payload)
        : createDepartment(payload);
    },
    onSuccess: () => {
      toast.success(department ? 'Department updated' : `Department “${name.trim()}” created`);
      onOpenChange(false);
      onSaved();
    },
  });

  const broken = hours ? invalidDays(normalizeBusinessHours(hours)) : [];

  function submit() {
    if (!name.trim()) {
      setNameError('Give the department a name — operators pick it from a list.');
      return;
    }
    setNameError(null);
    save.mutate();
  }

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      size="lg"
      title={department ? `Edit ${department.name}` : 'New department'}
      description="A group operators belong to, so a conversation can be routed to the right people."
      dismissible={!save.isPending}
      footer={
        <>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={save.isPending}>
            Cancel
          </Button>
          <Button onClick={submit} loading={save.isPending} disabled={broken.length > 0}>
            {department ? 'Save changes' : 'Create department'}
          </Button>
        </>
      }
    >
      <div className="space-y-5">
        {save.isError ? (
          <Alert tone="danger" live title="We could not save that">
            {save.error instanceof Error
              ? save.error.message
              : 'Something went wrong. Please try again.'}
          </Alert>
        ) : null}

        <Field label="Name" required error={nameError}>
          <Input
            value={name}
            onChange={(event) => {
              setName(event.target.value);
              setNameError(null);
            }}
            placeholder="Billing"
          />
        </Field>

        <Field label="Description" optional hint="Reminds your team what belongs here.">
          <Textarea
            rows={2}
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            placeholder="Questions about invoices, refunds and plans."
          />
        </Field>

        <div>
          <h3 className="text-base font-medium text-text-primary">Opening hours</h3>
          <p className="mb-2.5 mt-1 text-xs text-text-secondary">
            When this group is available for live chat.
          </p>
          <BusinessHoursEditor value={hours} onChange={setHours} disabled={save.isPending} />
        </div>
      </div>
    </Dialog>
  );
}
