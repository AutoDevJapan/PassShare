import { LucideIcon } from 'lucide-react';

interface FeatureCardProps {
  icon: LucideIcon;
  title: string;
  description: string;
}

export default function FeatureCard({ icon: Icon, title, description }: FeatureCardProps) {
  return (
    <div className="card-hover p-5 group">
      <div className="flex items-start gap-4">
        <div className="w-10 h-10 rounded-lg bg-primary-500/10 flex items-center justify-center flex-shrink-0 group-hover:bg-primary-500/20 transition-colors">
          <Icon className="h-5 w-5 text-primary-400" />
        </div>
        <div>
          <h3 className="font-medium text-white mb-1">{title}</h3>
          <p className="text-dark-400 text-sm leading-relaxed">{description}</p>
        </div>
      </div>
    </div>
  );
}
