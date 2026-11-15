// 室内配图：来自 Unsplash（Unsplash License，可免费商用），已下载到 public/interiors/ 由本站提供，
// 避免国内访问 images.unsplash.com 缓慢或失败。这些是通用装饰图，不是任何项目的设计成果。
export const INTERIOR_IMAGES = {
  living: '/interiors/living.jpg',
  livingWarm: '/interiors/livingWarm.jpg',
  kitchen: '/interiors/kitchen.jpg',
  bedroom: '/interiors/bedroom.jpg',
  architecture: '/interiors/architecture.jpg',
  dining: '/interiors/dining.jpg',
  neutral: '/interiors/neutral.jpg',
  detail: '/interiors/detail.jpg',
  luxury: '/interiors/luxury.jpg',
  workspace: '/interiors/workspace.jpg',
  texture: '/interiors/texture.jpg',
  outdoor: '/interiors/outdoor.jpg',
} as const;

// 上面的图只用于与具体项目无关的页头装饰。凡是代表某个真实项目的位置（项目卡片、项目页头、设计意向），
// 一律用该项目自己保存的成果，没有成果就不放图，不能用配图冒充项目内容。

type SavedResult = { kind: string; content: unknown };
type SavedImage = { room?: string; url?: string; b64?: string; estimated?: boolean };
export interface ProjectCover { src: string; label: string; kind: 'render' | 'plan' }

/** 该项目已保存、且确有图片的空间效果图（Agnes 为这个项目生成的），按保存顺序。 */
export function projectRenders(results: SavedResult[] | undefined): { src: string; room: string; estimated: boolean }[] {
  const images = (results?.find(r => r.kind === 'decorations')?.content as { images?: SavedImage[] } | undefined)?.images ?? [];
  return images.filter(i => i && (i.url || i.b64)).map(i => ({ src: i.url ?? `data:image/png;base64,${i.b64}`, room: i.room || '空间', estimated: !!i.estimated }));
}

/** 项目自己的图纸：标准户型图、业主上传的户型图，或程序按户型数据画的二维图。 */
function projectPlan(results: SavedResult[] | undefined): ProjectCover | null {
  const of = (kind: string) => results?.find(r => r.kind === kind)?.content;
  const fp = of('floorplan') as { stdImage?: string; image?: string } | undefined;
  if (fp?.stdImage) return { src: fp.stdImage, label: '本项目的标准户型图', kind: 'plan' };
  if (fp?.image) return { src: fp.image, label: '业主上传的户型图', kind: 'plan' };
  const svg = (of('design') as { svg?: string } | undefined)?.svg;
  if (svg) return { src: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`, label: '本项目的二维布局图', kind: 'plan' };
  return null;
}

/**
 * 代表一个项目的图片，只取这个项目自己的成果。prefer='plan' 先取图纸（装修公司看项目用），
 * 'render' 先取效果图（业主自己的卡片和页头用）。两者都没有时返回 null：调用处不放图。
 */
export function projectCover(results: SavedResult[] | undefined, prefer: 'plan' | 'render'): ProjectCover | null {
  const shot = projectRenders(results)[0];
  const render: ProjectCover | null = shot ? { src: shot.src, label: `本项目的${shot.room}效果图${shot.estimated ? '（示意）' : ''}`, kind: 'render' } : null;
  const plan = projectPlan(results);
  return prefer === 'plan' ? plan ?? render : render ?? plan;
}
