"""Image measurements for the event experiment; no physical pitch scale is assumed."""
import cv2
import numpy as np


def kit_group(bgr, box):
    x1, y1, x2, y2 = box[:4]
    w, h = x2 - x1, y2 - y1
    roi = bgr[max(0, int(y1 + h * 0.2)):min(bgr.shape[0], int(y1 + h * 0.55)),
              max(0, int(x1 + w * 0.3)):min(bgr.shape[1], int(x1 + w * 0.7))]
    if roi.size < 27:
        return "unknown"
    hsv = cv2.cvtColor(roi, cv2.COLOR_BGR2HSV).reshape(-1, 3)
    hue, sat, val = hsv.T
    blue = ((hue >= 90) & (hue <= 135) & (sat > 80) & (val > 40)).mean()
    light = ((sat < 70) & (val > 120)).mean()
    red = (((hue < 10) | (hue > 170)) & (sat > 90) & (val > 60)).mean()
    if blue > 0.3:
        return "blue"
    if red > 0.35:
        return "red"
    if light > 0.45:
        return "light"
    return "unknown"


class CameraMotion:
    def __init__(self):
        self.previous = self.mask = None

    def update(self, bgr, people):
        gray = cv2.cvtColor(bgr, cv2.COLOR_BGR2GRAY)
        h, w = gray.shape
        result = None
        if self.previous is not None:
            points = cv2.goodFeaturesToTrack(self.previous, maxCorners=300, qualityLevel=0.008, minDistance=8, mask=self.mask)
            if points is not None and len(points) >= 10:
                moved, status, _ = cv2.calcOpticalFlowPyrLK(self.previous, gray, points, None, winSize=(21, 21), maxLevel=3)
                if moved is not None:
                    old, new = points[status.ravel() == 1].reshape(-1, 2), moved[status.ravel() == 1].reshape(-1, 2)
                    if len(old) >= 10:
                        matrix, inliers = cv2.findHomography(old, new, cv2.RANSAC, 2.5)
                        if matrix is not None and inliers is not None and inliers.sum() >= 10 and inliers.mean() >= 0.6:
                            matrix /= matrix[2, 2]
                            if np.all(np.isfinite(matrix)) and 0.7 < np.linalg.det(matrix[:2, :2]) < 1.4:
                                result = matrix.tolist()
        hsv = cv2.cvtColor(bgr, cv2.COLOR_BGR2HSV)
        mask = cv2.inRange(hsv, (25, 30, 15), (95, 255, 255))
        mask[:int(h * 0.3)] = 0
        mask[int(h * 0.96):] = 0
        for x1, y1, x2, y2, *_ in people:
            cv2.rectangle(mask, (max(0, int(x1) - 3), max(0, int(y1) - 3)),
                          (min(w - 1, int(x2) + 3), min(h - 1, int(y2) + 3)), 0, -1)
        self.previous, self.mask = gray, mask
        return result
