import { LucideIcon } from 'lucide-react';

interface FeatureCardProps {
  icon: LucideIcon;
  title: string;
  description: string;
}

export default function FeatureCard({ icon: Icon, title, description }: FeatureCardProps) {
  return (
    <div className="card p-6 hover:border-primary-500/50 transition-colors">
      <div className="w-12 h-12 rounded-lg bg-primary-500/10 flex items-center justify-center mb-4">
        <Icon className="h-6 w-6 text-primary-400" />
      </div>
      <h3 className="text-lg font-semibold mb-2">{title}</h3>
      <p className="text-dark-400 text-sm">{description}</p>
    </div>
  );
}
