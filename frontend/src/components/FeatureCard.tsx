import { LucideIcon } from 'lucide-react';

interface FeatureCardProps {
  icon: LucideIcon;
  title: string;
  description: string;
}

export default function FeatureCard({ icon: Icon, title, description }: FeatureCardProps) {
  return (
    <div className="card-hover p-5 group relative overflow-hidden backdrop-blur-sm bg-dark-800/80 hover:border-primary-500/50 transition-all duration-300">
      {/* Hover glow effect */}
      <div className="absolute inset-0 bg-gradient-to-r from-primary-500/0 via-primary-500/5 to-cyan-500/0 opacity-0 group-hover:opacity-100 transition-opacity duration-500"></div>
      
      <div className="flex items-start gap-4 relative z-10">
        <div className="w-10 h-10 rounded-lg bg-primary-500/10 flex items-center justify-center flex-shrink-0 group-hover:bg-primary-500/20 transition-colors group-hover:shadow-lg group-hover:shadow-primary-500/20">
          <Icon className="h-5 w-5 text-primary-400 group-hover:scale-110 transition-transform" />
        </div>
        <div>
          <h3 className="font-medium text-white mb-1 group-hover:text-primary-300 transition-colors">{title}</h3>
          <p className="text-dark-400 text-sm leading-relaxed">{description}</p>
        </div>
      </div>
    </div>
  );
}
