# Create your models here.
from django.db import models
from django.contrib.auth.models import User

class Topic(models.Model):
    name = models.CharField(max_length=80)

    def __str__(self):
        return self.name

class Thread(models.Model):
    topic = models.ForeignKey(Topic, on_delete=models.CASCADE, related_name="threads")
    title = models.CharField(max_length=200)
    author = models.ForeignKey(User, on_delete=models.CASCADE)
    created_at = models.DateTimeField(auto_now_add=True)

    def __str__(self):
        return self.title

class Post(models.Model):
    thread = models.ForeignKey(Thread, on_delete=models.CASCADE, related_name="posts")
    author = models.ForeignKey(User, on_delete=models.CASCADE)
    content = models.TextField()
    created_at = models.DateTimeField(auto_now_add=True)